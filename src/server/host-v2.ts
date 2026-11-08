import path from "node:path"
import type { SessionInfo } from "../notifier.js"
import { cancelFormHTTP, replyFormHTTP } from "../opencode/form-http.js"
import { normalizeSessionInfo } from "../opencode/session.js"
import { LarkNotifyRpc } from "../rpc.js"
import type { FormAnswer } from "../types.js"
import { createRuntime, type LogLevel, type ServerHost, type ServerRuntime } from "./runtime.js"

/** The subset of the OpenCode 2.x Promise plugin context this plugin uses. */
export interface V2PluginContext {
  app?: { version?: string; channel?: string }
  location?: { directory?: string | undefined; workspaceID?: string | undefined }
  options?: Record<string, unknown>
  event: {
    subscribe(options?: { signal?: AbortSignal; types?: readonly string[] }): AsyncIterable<unknown>
  }
  session: {
    get(input: { sessionID: string }): Promise<unknown>
    form?: {
      reply(input: { sessionID: string; formID: string; answer: FormAnswer }): Promise<void>
      cancel(input: { sessionID: string; formID: string; message?: string }): Promise<void>
    }
  }
  permission: {
    reply(input: {
      sessionID: string
      requestID: string
      decision: "once" | "always" | "reject"
    }): Promise<void>
  }
  rpc?: {
    // Kept loose so one declaration works across 2.x RPC typings; the shared
    // contract is validated at runtime by the host.
    register(definition: any, handlers: any): Promise<unknown>
  }
}

export function createV2Host(ctx: V2PluginContext): ServerHost {
  const directory = ctx.location?.directory ?? process.cwd()
  return {
    kind: "v2",
    directory,
    options: ctx.options,
    log: (level, message) => log(level, message),
    loadSession: async (sessionID): Promise<SessionInfo> => {
      const session = await ctx.session.get({ sessionID })
      return normalizeSessionInfo(session)
    },
    replyQuestion: async () => {
      throw new Error("OpenCode 2 uses forms instead of questions")
    },
    rejectQuestion: async () => {
      throw new Error("OpenCode 2 uses forms instead of questions")
    },
    replyPermission: (requestID, sessionID, reply) =>
      ctx.permission.reply({ sessionID, requestID, decision: reply }),
    replyForm: async (sessionID, formID, answer) => {
      const form = ctx.session.form
      if (typeof form?.reply === "function") {
        await form.reply.call(form, { sessionID, formID, answer })
        return
      }
      await replyFormHTTP(process.env, sessionID, formID, answer)
    },
    cancelForm: async (sessionID, formID) => {
      const form = ctx.session.form
      if (typeof form?.cancel === "function") {
        await form.cancel.call(form, { sessionID, formID })
        return
      }
      await cancelFormHTTP(process.env, sessionID, formID)
    },
  }
}

interface LocationRef {
  directory: string
  workspaceID?: string | undefined
}

/**
 * OpenCode 2 boots one plugin instance per active location (project), but the
 * service's event stream is shared. Without this filter every open project
 * pushes the same question/permission card to Feishu.
 */
export function belongsToLocation(raw: unknown, own: string | LocationRef): boolean {
  const event = record(raw)
  const location = record(event?.location)
  const directory = stringField(location?.directory)
  // Events without a location are scoped by their session, below.
  if (!directory) return true
  const target = typeof own === "string" ? { directory: own } : own
  if (path.resolve(directory) !== path.resolve(target.directory)) return false
  return stringField(location?.workspaceID) === target.workspaceID
}

/**
 * Some 2.x lifecycle events (execution started/succeeded/...) carry no
 * `location`; resolve their session and compare that instead.
 */
async function belongsToHost(
  raw: unknown,
  ctx: V2PluginContext,
  host: ServerHost,
  signal: AbortSignal,
): Promise<boolean> {
  const event = record(raw)
  const location = record(event?.location)
  if (stringField(location?.directory)) {
    return belongsToLocation(event, { directory: host.directory, workspaceID: ctx.location?.workspaceID })
  }
  const sessionID = eventSessionID(event)
  if (!sessionID) return true
  try {
    const session = await host.loadSession(sessionID)
    if (signal.aborted) return false
    return belongsToLocation(
      { location: { directory: session.directory, workspaceID: session.workspaceID } },
      { directory: host.directory, workspaceID: ctx.location?.workspaceID },
    )
  } catch {
    // A session that cannot be loaded cannot be handled by any instance.
    return false
  }
}

/** Session IDs live at `data.sessionID` or, for forms, `data.form.sessionID`. */
function eventSessionID(event: Record<string, unknown> | undefined): string | undefined {
  const data = record(event?.data)
  const properties = record(event?.properties)
  return (
    stringField(data?.sessionID) ??
    stringField(record(data?.form)?.sessionID) ??
    stringField(properties?.sessionID) ??
    stringField(record(properties?.form)?.sessionID)
  )
}

/**
 * OpenCode 2 server plugin entry. The event stream is an async iterable; the
 * returned cleanup aborts it and drains the shared runtime. RPC registration is
 * feature-detected so older 2.x releases fall back to the file switch.
 */
export function setupV2(ctx: V2PluginContext): Promise<(() => Promise<void>) | undefined> {
  return setup(ctx)
}

async function setup(ctx: V2PluginContext): Promise<(() => Promise<void>) | undefined> {
  const host = createV2Host(ctx)
  const runtime = createRuntime(host)
  if (runtime.mode === "disabled") {
    await runtime.dispose()
    return undefined
  }

  const controller = new AbortController()
  void subscribe(ctx, controller, runtime, host)

  await registerRpc(ctx, runtime, host)

  await host.log(
    "info",
    `OpenCode ${ctx.app?.version ?? "2.x"} server plugin started (${runtime.mode})`,
  )

  return async () => {
    controller.abort()
    await runtime.dispose()
  }
}

async function subscribe(
  ctx: V2PluginContext,
  controller: AbortController,
  runtime: ServerRuntime,
  host: ServerHost,
): Promise<void> {
  const types = [
    "session.status",
    "session.idle",
    "session.execution.started",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "permission.asked",
    "permission.replied",
    "form.created",
    "form.replied",
    "form.cancelled",
  ] as const
  try {
    for await (const event of ctx.event.subscribe({ signal: controller.signal, types })) {
      if (!(await belongsToHost(event, ctx, host, controller.signal))) continue
      if (controller.signal.aborted) return
      await runtime.handleEvent(event)
    }
  } catch (error) {
    if (!controller.signal.aborted) await host.log("error", `OpenCode event stream failed: ${describe(error)}`)
  }
}

async function registerRpc(ctx: V2PluginContext, runtime: ServerRuntime, host: ServerHost): Promise<void> {
  if (!ctx.rpc || typeof ctx.rpc.register !== "function") return
  try {
    await ctx.rpc.register(LarkNotifyRpc as never, {
      status: async () => runtime.remoteStatus(),
      setRemote: async (input: unknown) => {
        const enabled = (input as { enabled?: unknown } | undefined)?.enabled
        if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean")
        runtime.setRemote(enabled)
        return { enabled: runtime.remoteStatus().enabled }
      },
    } as never)
  } catch (error) {
    await host.log("warn", `remote switch RPC unavailable: ${describe(error)}`)
  }
}

function log(level: LogLevel, message: string): void {
  const line = `[opencode-larknotify] ${message}`
  if (level === "debug") console.log(line)
  else if (level === "info") console.info(line)
  else if (level === "warn") console.warn(line)
  else console.error(line)
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

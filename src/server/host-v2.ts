import type { SessionInfo } from "../notifier.js"
import { cancelFormHTTP, replyFormHTTP } from "../opencode/form-http.js"
import { normalizeSessionInfo } from "../opencode/session.js"
import { LarkNotifyRpc } from "../rpc.js"
import type { FormAnswer } from "../types.js"
import { createRuntime, type LogLevel, type ServerHost, type ServerRuntime } from "./runtime.js"

/** The subset of the OpenCode 2.x Promise plugin context this plugin uses. */
export interface V2PluginContext {
  app?: { version?: string; channel?: string }
  location?: { directory?: string }
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
    "permission.asked",
    "permission.replied",
    "form.created",
    "form.replied",
    "form.cancelled",
  ] as const
  try {
    for await (const event of ctx.event.subscribe({ signal: controller.signal, types })) {
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

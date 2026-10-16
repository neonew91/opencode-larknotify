import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { sendFeishu } from "./feishu.js"
import { createNotifier, type SessionInfo } from "./notifier.js"
import { resolvePluginRuntime } from "./options.js"
import { createRemoteSwitch, resolveRemoteStatePath } from "./remote.js"
import type { DecisionRequest, Notification } from "./types.js"
import { ensureBroker, retireBroker } from "./bootstrap/ensure-broker.js"
import { BrokerIpcClient, BrokerRejectedError, type ApplyInstruction } from "./ipc/client.js"
import { rejectQuestion, replyPermission, replyQuestion, type OpenCodeApi } from "./opencode/reply.js"

const SERVICE = "opencode-larknotify"

type Level = "debug" | "info" | "warn" | "error"

const server: Plugin = async ({ client, directory }, inputOptions) => {
  const runtime = resolvePluginRuntime(inputOptions)

  const log = async (level: Level, message: string): Promise<void> => {
    try {
      await client.app.log({ body: { service: SERVICE, level, message } })
    } catch {
      // Notification failures must never affect OpenCode.
    }
  }

  if (runtime.mode === "disabled") {
    await log("warn", `Plugin disabled: ${runtime.reason}`)
    return {}
  }

  const instanceID = randomUUID()
  const loadSession = async (sessionID: string): Promise<SessionInfo> => {
    const result = await client.session.get({ path: { id: sessionID } })
    if (!result.data) throw new Error(`Session not found: ${sessionID}`)
    return result.data
  }

  let deliveryChain = Promise.resolve()
  const enqueue = (task: () => Promise<void>): void => {
    deliveryChain = deliveryChain.then(task).catch((error: unknown) => log("error", errorMessage(error)))
  }

  // The remote switch (toggled from the TUI) gates every push to Feishu: it is
  // the single source of truth, and it defaults to off.
  const remoteStatePath = resolveRemoteStatePath(process.env)
  const remote = createRemoteSwitch(remoteStatePath)
  const isRemoteEnabled = (): boolean => remote.enabled()
  // When the switch is off nothing is pushed, so say how to turn it on: an
  // environment without the TUI plugin has no other way to find out.
  const remoteLabel = (): string =>
    remote.enabled()
      ? "remote switch on"
      : `remote switch off; toggle it in the TUI (default ctrl+x f) or write {"enabled":true} to ${remoteStatePath}`
  const watchRemote = (flush: () => number): void => {
    remote.start((enabled) => {
      if (!enabled) {
        void log("info", "Feishu remote switched off; requests stay in OpenCode")
        return
      }
      const flushed = flush()
      void log("info", `Feishu remote switched on; pushed ${flushed} waiting request(s)`)
    })
  }

  // --- Notify-only mode (legacy custom-bot webhook) ---------------------------
  if (runtime.mode === "notify") {
    const webhook = runtime.webhook
    const notifier = createNotifier({
      mode: "notify",
      instanceID,
      homeDirectory: homedir(),
      behavior: runtime.behavior,
      loadSession,
      notify: (notification: Notification) => enqueue(() => sendFeishu(notification, webhook)),
      decide: () => {},
      isRemoteEnabled,
    })
    watchRemote(notifier.flushDeferred)

    let eventChain = Promise.resolve()
    await log("info", `Plugin enabled (notify) for ${directory}; ${remoteLabel()}`)
    return {
      event: async ({ event }) => {
        eventChain = eventChain
          .then(() => notifier.handle(event))
          .catch((error: unknown) => log("error", `Failed to process event: ${errorMessage(error)}`))
      },
      dispose: async () => {
        remote.stop()
        await eventChain
        await deliveryChain
      },
    }
  }

  // --- Interactive mode (application bot + broker, decision closed loop) -------
  const interactive = runtime.interactive
  const api: OpenCodeApi = { client, directory }

  const onApply = async (instruction: ApplyInstruction): Promise<{ ok: boolean; error?: string }> => {
    try {
      const reply = instruction.reply
      if (reply.kind === "question") await replyQuestion(api, instruction.requestID, reply.answers)
      else if (reply.kind === "question-reject") await rejectQuestion(api, instruction.requestID)
      else await replyPermission(api, instruction.requestID, reply.reply)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  // Lazily (re)establish the broker connection. Keeping it lazy means an idle
  // session never holds the broker open: the broker may self-retire while idle
  // and is woken up again on the next notification/decision. A crashed or
  // retired broker is transparently re-spawned and reconnected here, and a
  // broker running outdated code (it rejects our protocol) is replaced once.
  let link: BrokerIpcClient | undefined
  let connecting: Promise<BrokerIpcClient | undefined> | undefined

  const connectOnce = async (): Promise<BrokerIpcClient | undefined> => {
    const ready = await ensureBroker({
      socketPath: interactive.socketPath,
      env: process.env,
      logger: (level, message) => void log(level, message),
    })
    if (!ready) return undefined
    const client = new BrokerIpcClient({
      socketPath: interactive.socketPath,
      token: ready.token,
      instanceID,
      onApply,
      logger: (level, message) => void log(level, message),
    })
    try {
      await client.connect()
      return client
    } catch (error) {
      client.close()
      throw error
    }
  }

  const ensureLink = (): Promise<BrokerIpcClient | undefined> => {
    if (link?.connected) return Promise.resolve(link)
    if (connecting) return connecting
    connecting = (async () => {
      if (link && !link.connected) {
        link.close()
        link = undefined
      }
      try {
        link = await connectOnce()
      } catch (error) {
        if (!(error instanceof BrokerRejectedError) || !error.brokerPid) {
          await log("error", `broker connect failed: ${errorMessage(error)}`)
          return undefined
        }
        await log("warn", `broker pid ${error.brokerPid} rejected this plugin (${error.message}); replacing it`)
        await retireBroker(error.brokerPid, interactive.socketPath)
        try {
          link = await connectOnce()
        } catch (retryError) {
          await log("error", `broker connect failed after replacement: ${errorMessage(retryError)}`)
          return undefined
        }
      }
      return link
    })()
    return connecting.finally(() => {
      connecting = undefined
    })
  }

  const notifier = createNotifier({
    mode: "interactive",
    instanceID,
    homeDirectory: homedir(),
    behavior: runtime.behavior,
    loadSession,
    notify: (notification: Notification) =>
      enqueue(async () => {
        const client = await ensureLink()
        if (!client) {
          await log("warn", "broker unavailable; notification dropped")
          return
        }
        await client.notify(notification)
      }),
    decide: (request: DecisionRequest) =>
      enqueue(async () => {
        const client = await ensureLink()
        if (!client) {
          await log("warn", "broker unavailable; decision cannot be delivered")
          return
        }
        await client.decide(request)
      }),
    isRemoteEnabled,
  })
  watchRemote(notifier.flushDeferred)

  let eventChain = Promise.resolve()
  await log("info", `Plugin enabled (interactive) for ${directory}; ${remoteLabel()}`)

  return {
    event: async ({ event }) => {
      eventChain = eventChain
        .then(async () => {
          await notifier.handle(event)
          const requestID = resolvedRequestID(event)
          if (requestID && link?.connected) link.resolveLocal(requestID)
        })
        .catch((error: unknown) => log("error", `Failed to process event: ${errorMessage(error)}`))
    },
    dispose: async () => {
      remote.stop()
      await eventChain
      await deliveryChain
      link?.close()
    },
  }
}

function resolvedRequestID(event: { type: string; properties: unknown }): string | undefined {
  if (event.type !== "permission.replied" && event.type !== "question.replied" && event.type !== "question.rejected") {
    return undefined
  }
  const props = event.properties
  if (typeof props !== "object" || props === null) return undefined
  const requestID = (props as Record<string, unknown>).requestID
  return typeof requestID === "string" && requestID ? requestID : undefined
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  let redacted = message
  for (const key of ["OPENCODE_FEISHU_WEBHOOK", "OPENCODE_FEISHU_APP_SECRET"]) {
    const value = process.env[key]
    if (value) redacted = redacted.replaceAll(value, "[redacted]")
  }
  return redacted.slice(0, 500)
}

const plugin = {
  id: "opencode.feishu-webhook",
  server,
} satisfies PluginModule

export default plugin

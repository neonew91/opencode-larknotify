import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { ensureBroker, retireBroker } from "../bootstrap/ensure-broker.js"
import { sendFeishu } from "../feishu.js"
import { BrokerIpcClient, BrokerRejectedError, type ApplyInstruction } from "../ipc/client.js"
import { createNotifier, type SessionInfo } from "../notifier.js"
import { normalizeEvent, resolvedRequestID } from "../opencode/events.js"
import { resolvePluginRuntime } from "../options.js"
import { createRemoteSwitch, resolveRemoteStatePath, writeRemoteState } from "../remote.js"
import type { DecisionRequest, FormAnswer, Notification } from "../types.js"

export type LogLevel = "debug" | "info" | "warn" | "error"

/**
 * Everything the shared runtime needs from the host plugin API. The OpenCode
 * 1.x and 2.x adapters implement this small surface, keeping notifications,
 * deferral and broker routing identical across versions.
 */
export interface ServerHost {
  readonly kind: "v1" | "v2"
  readonly directory: string
  readonly options: Record<string, unknown> | undefined
  log(level: LogLevel, message: string): void | Promise<void>
  loadSession(sessionID: string): Promise<SessionInfo>
  replyQuestion(requestID: string, answers: string[][]): Promise<void>
  rejectQuestion(requestID: string): Promise<void>
  /** `sessionID` is required by OpenCode 2 and ignored by 1.x. */
  replyPermission(requestID: string, sessionID: string, reply: "once" | "reject"): Promise<void>
  replyForm(sessionID: string, formID: string, answer: FormAnswer): Promise<void>
  cancelForm(sessionID: string, formID: string): Promise<void>
}

export interface RemoteStatus {
  enabled: boolean
  mode: "disabled" | "interactive" | "notify"
}

export interface ServerRuntime {
  readonly mode: "disabled" | "notify" | "interactive"
  /** Feed one raw OpenCode 1.x/2.x event into the runtime. */
  handleEvent(raw: unknown): Promise<void>
  dispose(): Promise<void>
  remoteStatus(): RemoteStatus
  /** Write the shared switch and flush anything deferred in this process. */
  setRemote(enabled: boolean): void
}

const SERVICE = "opencode-larknotify"

export function createRuntime(host: ServerHost): ServerRuntime {
  const log = async (level: LogLevel, message: string): Promise<void> => {
    try {
      await host.log(level, message)
    } catch {
      // Notification failures must never affect OpenCode.
    }
  }

  const runtime = resolvePluginRuntime(host.options, process.env)
  if (runtime.mode === "disabled") {
    void log("warn", `Plugin disabled: ${runtime.reason}`)
    return disabledRuntime()
  }

  const instanceID = randomUUID()
  const loadSession = host.loadSession

  let deliveryChain = Promise.resolve()
  const enqueue = (task: () => Promise<void>): void => {
    deliveryChain = deliveryChain.then(task).catch((error: unknown) => log("error", errorMessage(error)))
  }

  // The remote switch (toggled from the TUI or RPC) gates every push to Feishu:
  // it is the single source of truth, and it defaults to off.
  const remoteStatePath = resolveRemoteStatePath(process.env)
  const remote = createRemoteSwitch(remoteStatePath)
  const isRemoteEnabled = (): boolean => remote.enabled()
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

  let eventChain = Promise.resolve()
  let link: BrokerIpcClient | undefined
  let flushDeferred: () => number = () => 0

  const handleEvent = (raw: unknown): Promise<void> => {
    const event = normalizeEvent(raw)
    if (!event) return eventChain
    eventChain = eventChain
      .then(async () => {
        await notifier.handle(event)
        const requestID = resolvedRequestID(event)
        if (requestID && link?.connected) link.resolveLocal(requestID)
      })
      .catch((error: unknown) => log("error", `Failed to process event: ${errorMessage(error)}`))
    return eventChain
  }

  const remoteStatus = (): RemoteStatus => {
    const state = remote.check()
    return { enabled: state.enabled, mode: runtime.mode }
  }

  const setRemote = (enabled: boolean): void => {
    writeRemoteState(remoteStatePath, enabled)
    // check() flips the watcher and flushes deferred requests once. The extra
    // flush is intentional and cheap: it covers a listener that was not ready.
    remote.check()
    flushDeferred()
  }

  let notifier: ReturnType<typeof createNotifier>

  if (runtime.mode === "notify") {
    notifier = createNotifier({
      mode: "notify",
      instanceID,
      homeDirectory: homedir(),
      behavior: runtime.behavior,
      loadSession,
      notify: (notification: Notification) =>
        enqueue(() => sendFeishu(notification, runtime.webhook)),
      decide: () => {},
      isRemoteEnabled,
    })
    flushDeferred = notifier.flushDeferred
    watchRemote(notifier.flushDeferred)
    void log("info", `Plugin enabled (notify) for ${host.directory}; ${remoteLabel()}`)
    return {
      mode: "notify",
      handleEvent,
      dispose: async () => {
        remote.stop()
        await eventChain
        await deliveryChain
      },
      remoteStatus,
      setRemote,
    }
  }

  const interactive = runtime.interactive

  const onApply = async (instruction: ApplyInstruction): Promise<{ ok: boolean; error?: string }> => {
    try {
      const reply = instruction.reply
      if (instruction.requestKind === "permission") {
        if (reply.kind !== "permission") throw new Error("permission request received a non-permission reply")
        await host.replyPermission(instruction.requestID, instruction.sessionID, reply.reply)
      } else if (instruction.requestKind === "form") {
        if (reply.kind === "form") {
          await host.replyForm(instruction.sessionID, instruction.requestID, reply.answer)
        } else if (reply.kind === "form-cancel") {
          await host.cancelForm(instruction.sessionID, instruction.requestID)
        } else {
          throw new Error("form request received an unsupported reply")
        }
      } else {
        if (reply.kind === "question") {
          await host.replyQuestion(instruction.requestID, reply.answers)
        } else if (reply.kind === "question-reject") {
          await host.rejectQuestion(instruction.requestID)
        } else {
          throw new Error("question request received an unsupported reply")
        }
      }
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
      host: host.kind,
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

  notifier = createNotifier({
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
  flushDeferred = notifier.flushDeferred
  watchRemote(notifier.flushDeferred)

  void log("info", `Plugin enabled (interactive) for ${host.directory}; ${remoteLabel()}`)

  return {
    mode: "interactive",
    handleEvent,
    dispose: async () => {
      remote.stop()
      await eventChain
      await deliveryChain
      link?.close()
    },
    remoteStatus,
    setRemote,
  }
}

function disabledRuntime(): ServerRuntime {
  return {
    mode: "disabled",
    handleEvent: async () => {},
    dispose: async () => {},
    remoteStatus: () => ({ enabled: false, mode: "disabled" }),
    setRemote: () => {},
  }
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

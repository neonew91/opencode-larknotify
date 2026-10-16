import { randomUUID } from "node:crypto"
import type { DecisionRequest, Notification, Reply, RequestKind } from "../types.js"
import {
  PROTOCOL_VERSION,
  createNdjsonDecoder,
  encodeMessage,
  type BrokerMessage,
  type PluginMessage,
} from "./protocol.js"

export interface ApplyInstruction {
  requestID: string
  requestKind: RequestKind
  reply: Reply
}

/** The broker refused the handshake (outdated protocol or token mismatch). */
export class BrokerRejectedError extends Error {
  constructor(
    message: string,
    readonly brokerPid: number,
    readonly brokerProtocol: number,
  ) {
    super(message)
    this.name = "BrokerRejectedError"
  }
}

export interface IpcClientOptions {
  socketPath: string
  token: string
  instanceID: string
  onApply: (instruction: ApplyInstruction) => Promise<{ ok: boolean; error?: string }>
  logger?: (level: "debug" | "info" | "warn" | "error", message: string) => void
  requestTimeoutMs?: number
}

interface Pending {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type BunSocket = { write: (data: string) => void; end: () => void }

/**
 * Plugin-side connection to the broker. All failures are surfaced so the caller
 * can degrade to "no notification" instead of ever blocking OpenCode.
 */
export class BrokerIpcClient {
  private socket: BunSocket | undefined
  private readonly pending = new Map<string, Pending>()
  private readonly decoder = createNdjsonDecoder()
  private welcome: { resolve: () => void; reject: (error: Error) => void } | undefined
  private connectedFlag = false
  private readonly timeout: number

  constructor(private readonly options: IpcClientOptions) {
    this.timeout = options.requestTimeoutMs ?? 15_000
  }

  get connected(): boolean {
    return this.connectedFlag
  }

  async connect(): Promise<void> {
    const connect = (globalThis as { Bun?: { connect: (opts: unknown) => Promise<unknown> } }).Bun?.connect
    if (!connect) throw new Error("Bun runtime is required for broker IPC")

    const welcomePromise = new Promise<void>((resolve, reject) => {
      this.welcome = { resolve, reject }
    })

    this.socket = (await connect({
      unix: this.options.socketPath,
      socket: {
        data: (_socket: unknown, data: Buffer) => this.onData(data.toString("utf8")),
        close: () => this.onClose(),
        error: (_socket: unknown, error: Error) => this.onSocketError(error),
      },
    })) as BunSocket

    this.send({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      token: this.options.token,
      instanceID: this.options.instanceID,
      pid: process.pid,
    })

    const timer = setTimeout(() => this.welcome?.reject(new Error("broker handshake timed out")), this.timeout)
    try {
      await welcomePromise
    } finally {
      clearTimeout(timer)
    }
  }

  notify(notification: Notification): Promise<void> {
    return this.request((id) => ({ type: "notify", id, notification }))
  }

  decide(request: DecisionRequest): Promise<void> {
    return this.request((id) => ({ type: "decision", id, request }))
  }

  resolveLocal(requestID: string): void {
    if (!this.socket) return
    try {
      this.send({ type: "resolve", requestID })
    } catch {
      // best effort
    }
  }

  close(): void {
    this.connectedFlag = false
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error("broker connection closed"))
    }
    this.pending.clear()
    try {
      this.socket?.end()
    } catch {
      // ignore
    }
    this.socket = undefined
  }

  private request(build: (id: string) => PluginMessage): Promise<void> {
    if (!this.socket || !this.connectedFlag) {
      return Promise.reject(new Error("broker not connected"))
    }
    const id = randomUUID()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error("broker request timed out"))
      }, this.timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send(build(id))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private send(message: PluginMessage): void {
    if (!this.socket) throw new Error("broker not connected")
    this.socket.write(encodeMessage(message))
  }

  private onData(chunk: string): void {
    for (const parsed of this.decoder.push(chunk)) {
      this.onMessage(parsed as BrokerMessage)
    }
  }

  private onMessage(message: BrokerMessage): void {
    switch (message.type) {
      case "welcome": {
        if (message.ok) {
          this.connectedFlag = true
          this.welcome?.resolve()
        } else {
          this.welcome?.reject(
            new BrokerRejectedError(message.error ?? "broker rejected connection", message.brokerPid, message.protocol),
          )
        }
        this.welcome = undefined
        return
      }
      case "result": {
        const pending = this.pending.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.ok) pending.resolve()
        else pending.reject(new Error(message.error ?? "broker request failed"))
        return
      }
      case "apply": {
        void this.handleApply(message.id, {
          requestID: message.requestID,
          requestKind: message.requestKind,
          reply: message.reply,
        })
        return
      }
      case "ping": {
        try {
          this.send({ type: "pong", id: message.id })
        } catch {
          // ignore
        }
        return
      }
    }
  }

  private async handleApply(id: string, instruction: ApplyInstruction): Promise<void> {
    let result: { ok: boolean; error?: string }
    try {
      result = await this.options.onApply(instruction)
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    try {
      this.send({ type: "apply-result", id, ok: result.ok, ...(result.error ? { error: result.error } : {}) })
    } catch {
      // ignore
    }
  }

  private onClose(): void {
    this.connectedFlag = false
    this.welcome?.reject(new Error("broker connection closed"))
    this.welcome = undefined
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error("broker connection closed"))
    }
    this.pending.clear()
    this.options.logger?.("warn", "broker connection closed")
  }

  private onSocketError(error: Error): void {
    this.options.logger?.("error", `broker socket error: ${error.message}`)
  }
}

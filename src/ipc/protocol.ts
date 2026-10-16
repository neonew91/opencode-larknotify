import type { DecisionRequest, Notification, Reply, RequestKind } from "../types.js"

/**
 * Protocol history:
 * 1  single-question decisions
 * 2  multi-question wizard; question notifications carry `questions[]`
 *
 * The broker accepts every version from MIN_COMPATIBLE_PROTOCOL so plugins that
 * were loaded before an upgrade keep working. A plugin always sends its own
 * version, which lets an outdated broker reject it and be replaced.
 */
export const PROTOCOL_VERSION = 2
export const MIN_COMPATIBLE_PROTOCOL = 1

export function isCompatibleProtocol(version: unknown): boolean {
  return typeof version === "number" && Number.isInteger(version) && version >= MIN_COMPATIBLE_PROTOCOL && version <= PROTOCOL_VERSION
}

export interface PluginHello {
  type: "hello"
  protocol: number
  token: string
  instanceID: string
  pid: number
}

export interface PluginNotify {
  type: "notify"
  id: string
  notification: Notification
}

export interface PluginDecision {
  type: "decision"
  id: string
  request: DecisionRequest
}

/**
 * OpenCode reported the request as replied or rejected. The plugin can not tell
 * a terminal answer from the echo of a Feishu write-back, so the broker decides:
 * a card still waiting for input is retracted, a card being written back is kept.
 */
export interface PluginResolve {
  type: "resolve"
  requestID: string
}

/** Response to a broker `apply`: whether the local OpenCode write succeeded. */
export interface PluginApplyResult {
  type: "apply-result"
  id: string
  ok: boolean
  error?: string
}

export interface PluginPong {
  type: "pong"
  id: string
}

export type PluginMessage = PluginHello | PluginNotify | PluginDecision | PluginResolve | PluginApplyResult | PluginPong

export interface BrokerWelcome {
  type: "welcome"
  ok: boolean
  protocol: number
  brokerPid: number
  error?: string
}

export interface BrokerResult {
  type: "result"
  id: string
  ok: boolean
  error?: string
}

/** Instruct the plugin to write the user's decision back into its OpenCode session. */
export interface BrokerApply {
  type: "apply"
  id: string
  requestID: string
  requestKind: RequestKind
  reply: Reply
}

export interface BrokerPing {
  type: "ping"
  id: string
}

export type BrokerMessage = BrokerWelcome | BrokerResult | BrokerApply | BrokerPing

export function encodeMessage(message: PluginMessage | BrokerMessage): string {
  return `${JSON.stringify(message)}\n`
}

/** Stateful NDJSON decoder: feed raw chunks, receive complete parsed objects. */
export function createNdjsonDecoder(): { push: (chunk: string) => unknown[] } {
  let buffer = ""
  return {
    push(chunk: string): unknown[] {
      buffer += chunk
      const out: unknown[] = []
      let index = buffer.indexOf("\n")
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.length > 0) {
          try {
            out.push(JSON.parse(line))
          } catch {
            // ignore malformed line; a partial frame will arrive in the next chunk
          }
        }
        index = buffer.indexOf("\n")
      }
      return out
    },
  }
}

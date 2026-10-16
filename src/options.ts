import os from "node:os"
import path from "node:path"
import type { PluginOptions } from "@opencode-ai/plugin"

export interface NotifierOptions {
  notifyOnIdle?: boolean
  notifyOnPermission?: boolean
  notifyOnQuestion?: boolean
  minimumDurationMs?: number
  permissionRemote?: boolean
}

export interface NotifierBehavior {
  notifyOnIdle: boolean
  notifyOnPermission: boolean
  notifyOnQuestion: boolean
  minimumDurationMs: number
  /** Allow replying to permission requests remotely (only `once` / `reject`, never `always`). */
  permissionRemote: boolean
}

/** Options of the TUI plugin (`tui.json` second tuple element). */
export interface TuiOptions {
  /** Key bindings of the remote toggle; empty disables the shortcut. */
  keybinds: string[]
  /** Show a banner at the bottom of the screen while remote mode is on. */
  banner: boolean
}

export const DEFAULT_REMOTE_KEYBIND = "<leader>f"

export interface WebhookConfig {
  webhook: string
  secret?: string
  atUserID?: string
}

export interface InteractiveConfig {
  appId: string
  appSecret: string
  receiveId: string
  receiveIdType: ReceiveIdType
  allowedOpenIds: string[]
  socketPath: string
}

export interface BrokerConfig extends InteractiveConfig {
  /** How long a pending action stays valid before the card is marked expired. */
  actionTtlMs: number
  /** Shut the broker down after being idle (no connections, no pending) this long. */
  idleShutdownMs: number
  domain: string
}

export type ReceiveIdType = "chat_id" | "open_id" | "user_id" | "union_id" | "email"

export type PluginRuntime =
  | { mode: "disabled"; reason: string }
  | { mode: "notify"; behavior: NotifierBehavior; webhook: WebhookConfig }
  | { mode: "interactive"; behavior: NotifierBehavior; interactive: InteractiveConfig }

export type BrokerConfigResult = { ok: true; value: BrokerConfig } | { ok: false; message: string }

const OPEN_ID_PATTERN = /^[A-Za-z0-9_@.-]{1,128}$/
const RECEIVE_ID_TYPES: ReceiveIdType[] = ["chat_id", "open_id", "user_id", "union_id", "email"]
const DEFAULT_ACTION_TTL_MS = 30 * 60 * 1000
const DEFAULT_IDLE_SHUTDOWN_MS = 30 * 60 * 1000

export function resolveSocketPath(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.OPENCODE_FEISHU_SOCKET?.trim()
  if (explicit) return explicit
  const base = env.XDG_RUNTIME_DIR?.trim() || os.tmpdir()
  return path.join(base, "opencode-feishu", "broker.sock")
}

function parseBehavior(input: PluginOptions | undefined): { ok: true; value: NotifierBehavior } | { ok: false; message: string } {
  const options = (input ?? {}) as NotifierOptions
  for (const key of ["notifyOnIdle", "notifyOnPermission", "notifyOnQuestion", "permissionRemote"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") {
      return { ok: false, message: `${key} must be a boolean` }
    }
  }
  if (
    options.minimumDurationMs !== undefined &&
    (!Number.isFinite(options.minimumDurationMs) || options.minimumDurationMs < 0)
  ) {
    return { ok: false, message: "minimumDurationMs must be a non-negative number" }
  }
  return {
    ok: true,
    value: {
      notifyOnIdle: options.notifyOnIdle ?? true,
      notifyOnPermission: options.notifyOnPermission ?? true,
      notifyOnQuestion: options.notifyOnQuestion ?? true,
      minimumDurationMs: options.minimumDurationMs ?? 0,
      permissionRemote: options.permissionRemote ?? true,
    },
  }
}

/** Parse TUI plugin options. Invalid values fall back to defaults and are reported as warnings. */
export function parseTuiOptions(input: PluginOptions | undefined): { value: TuiOptions; warnings: string[] } {
  const options = (input ?? {}) as Record<string, unknown>
  const warnings: string[] = []

  let keybinds = [DEFAULT_REMOTE_KEYBIND]
  const keybind = options.keybind
  if (keybind === false || keybind === "none") {
    keybinds = []
  } else if (typeof keybind === "string" && keybind.trim()) {
    keybinds = [keybind.trim()]
  } else if (Array.isArray(keybind) && keybind.length > 0 && keybind.every((item) => typeof item === "string" && item.trim())) {
    keybinds = keybind.map((item: string) => item.trim())
  } else if (keybind !== undefined) {
    warnings.push(`keybind must be a key string, an array of key strings, "none" or false; using ${DEFAULT_REMOTE_KEYBIND}`)
  }

  let banner = true
  if (typeof options.banner === "boolean") banner = options.banner
  else if (options.banner !== undefined) warnings.push("banner must be a boolean; using true")

  return { value: { keybinds, banner }, warnings }
}

function parseAllowedOpenIds(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

function readInteractiveEnv(env: Record<string, string | undefined>): InteractiveConfig | undefined {
  const appId = env.OPENCODE_FEISHU_APP_ID?.trim()
  const appSecret = env.OPENCODE_FEISHU_APP_SECRET?.trim()
  const receiveId = env.OPENCODE_FEISHU_RECEIVE_ID?.trim()
  if (!appId || !appSecret || !receiveId) return undefined

  const receiveIdTypeRaw = (env.OPENCODE_FEISHU_RECEIVE_ID_TYPE?.trim() || "chat_id") as ReceiveIdType
  const receiveIdType = RECEIVE_ID_TYPES.includes(receiveIdTypeRaw) ? receiveIdTypeRaw : "chat_id"

  return {
    appId,
    appSecret,
    receiveId,
    receiveIdType,
    allowedOpenIds: parseAllowedOpenIds(env.OPENCODE_FEISHU_ALLOWED_OPENID),
    socketPath: resolveSocketPath(env),
  }
}

function readWebhookConfig(env: Record<string, string | undefined>): { ok: true; value: WebhookConfig } | { ok: false; message: string } | undefined {
  const webhook = env.OPENCODE_FEISHU_WEBHOOK?.trim()
  if (!webhook) return undefined

  let url: URL
  try {
    url = new URL(webhook)
  } catch {
    return { ok: false, message: "OPENCODE_FEISHU_WEBHOOK is not a valid URL" }
  }
  if (url.protocol !== "https:" || !url.pathname.startsWith("/open-apis/bot/v2/hook/")) {
    return { ok: false, message: "OPENCODE_FEISHU_WEBHOOK must be an HTTPS Feishu bot webhook" }
  }

  const atUserID = env.OPENCODE_FEISHU_AT_USER_ID?.trim()
  if (atUserID && !OPEN_ID_PATTERN.test(atUserID)) {
    return { ok: false, message: "OPENCODE_FEISHU_AT_USER_ID is invalid" }
  }
  const secret = env.OPENCODE_FEISHU_SECRET?.trim()
  return {
    ok: true,
    value: {
      webhook: url.toString(),
      ...(secret ? { secret } : {}),
      ...(atUserID ? { atUserID } : {}),
    },
  }
}

/**
 * Resolve how the plugin should behave inside a single OpenCode process.
 *
 * Priority: a fully configured Feishu application (interactive, closed-loop)
 * wins over a legacy custom-bot webhook (one-way notify). Missing both disables
 * the plugin without ever throwing.
 */
export function resolvePluginRuntime(
  input: PluginOptions | undefined,
  env: Record<string, string | undefined> = process.env,
): PluginRuntime {
  const behavior = parseBehavior(input)
  if (!behavior.ok) return { mode: "disabled", reason: behavior.message }

  const interactive = readInteractiveEnv(env)
  if (interactive) {
    return { mode: "interactive", behavior: behavior.value, interactive }
  }

  const webhook = readWebhookConfig(env)
  if (webhook && !webhook.ok) return { mode: "disabled", reason: webhook.message }
  if (webhook && webhook.ok) {
    return { mode: "notify", behavior: behavior.value, webhook: webhook.value }
  }

  return {
    mode: "disabled",
    reason: "configure OPENCODE_FEISHU_APP_ID/APP_SECRET/RECEIVE_ID (interactive) or OPENCODE_FEISHU_WEBHOOK (notify)",
  }
}

/** Resolve the configuration the broker process needs. Called inside the broker entry. */
export function resolveBrokerConfig(env: Record<string, string | undefined> = process.env): BrokerConfigResult {
  const interactive = readInteractiveEnv(env)
  if (!interactive) {
    return { ok: false, message: "OPENCODE_FEISHU_APP_ID, OPENCODE_FEISHU_APP_SECRET and OPENCODE_FEISHU_RECEIVE_ID are required" }
  }
  if (interactive.allowedOpenIds.length === 0) {
    return { ok: false, message: "OPENCODE_FEISHU_ALLOWED_OPENID must list at least one open_id" }
  }
  for (const openId of interactive.allowedOpenIds) {
    if (!OPEN_ID_PATTERN.test(openId)) {
      return { ok: false, message: `OPENCODE_FEISHU_ALLOWED_OPENID contains an invalid id: ${openId}` }
    }
  }
  return {
    ok: true,
    value: {
      ...interactive,
      actionTtlMs: parsePositiveInt(env.OPENCODE_FEISHU_ACTION_TTL_MS, DEFAULT_ACTION_TTL_MS),
      idleShutdownMs: parsePositiveInt(env.OPENCODE_FEISHU_IDLE_SHUTDOWN_MS, DEFAULT_IDLE_SHUTDOWN_MS),
      domain: env.OPENCODE_FEISHU_DOMAIN?.trim() || "https://open.feishu.cn",
    },
  }
}

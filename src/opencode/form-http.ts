import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { FormAnswer } from "../types.js"

/**
 * OpenCode 2's Promise plugin context does not expose `session.form`, so the
 * only supported way for a server plugin to answer a form in 2.2.x is its own
 * HTTP API. Prefer a user-supplied endpoint; otherwise only use the registered
 * local service when it is the process this plugin runs inside. A PID mismatch
 * (standalone server, other service) is intentionally refused rather than
 * sending credentials to the wrong server.
 */
export interface ServerEndpoint {
  url: string
  headers?: Record<string, string>
}

const TIMEOUT_MS = 5_000

export function resolveServerEndpoint(env: Record<string, string | undefined> = process.env): ServerEndpoint | undefined {
  const explicit = env.OPENCODE_FEISHU_SERVER_URL?.trim()
  if (explicit) {
    const url = parseUrl(explicit)
    if (!url) return undefined
    const password =
      env.OPENCODE_FEISHU_SERVER_PASSWORD?.trim() ||
      env.OPENCODE_PASSWORD?.trim() ||
      env.OPENCODE_SERVER_PASSWORD?.trim()
    return { url: url.toString().replace(/\/$/, ""), ...(password ? { headers: basicAuth(password) } : {}) }
  }

  const file = path.join(
    env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state"),
    "opencode",
    "service.json",
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const service = parsed as Record<string, unknown>
  if (service.pid !== process.pid) return undefined
  const rawURL = typeof service.url === "string" ? service.url : undefined
  if (!rawURL) return undefined
  const url = parseUrl(rawURL)
  if (!url) return undefined
  const password = typeof service.password === "string" && service.password ? service.password : undefined
  return { url: url.toString().replace(/\/$/, ""), ...(password ? { headers: basicAuth(password) } : {}) }
}

export async function replyFormHTTP(
  env: Record<string, string | undefined>,
  sessionID: string,
  formID: string,
  answer: FormAnswer,
): Promise<void> {
  const endpoint = requireEndpoint(env)
  await request(
    endpoint,
    "POST",
    `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`,
    JSON.stringify({ answer }),
  )
}

export async function cancelFormHTTP(
  env: Record<string, string | undefined>,
  sessionID: string,
  formID: string,
  message = "Cancelled from Feishu",
): Promise<void> {
  const endpoint = requireEndpoint(env)
  const query = new URLSearchParams({ message })
  await request(
    endpoint,
    "DELETE",
    `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}?${query.toString()}`,
  )
}

function requireEndpoint(env: Record<string, string | undefined>): ServerEndpoint {
  const endpoint = resolveServerEndpoint(env)
  if (!endpoint) {
    throw new Error(
      "OpenCode 2 server endpoint not found; set OPENCODE_FEISHU_SERVER_URL (and password) or run inside the registered service",
    )
  }
  return endpoint
}

async function request(
  endpoint: ServerEndpoint,
  method: "POST" | "DELETE",
  pathname: string,
  body?: string,
): Promise<void> {
  const url = new URL(`${endpoint.url}${pathname}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(endpoint.headers ?? {}),
      },
      ...(body ? { body } : {}),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(`OpenCode API ${pathname} returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

function parseUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    return url
  } catch {
    return undefined
  }
}

function basicAuth(password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
}

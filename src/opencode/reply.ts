/**
 * Write a decision back into OpenCode.
 *
 * Must reuse the plugin-injected `client`: OpenCode's embedded server often has
 * no reachable network port, so the plugin's `client` uses an in-process fetch.
 * Building our own URL from `serverUrl` fails with "Unable to connect".
 */
export interface OpenCodeApi {
  /** The plugin-injected OpenCode client (`PluginInput.client`). */
  client: unknown
  directory: string
}

interface RequestResult {
  data?: unknown
  error?: unknown
  response?: { ok: boolean; status: number }
}

type LowLevelPost = (options: {
  url: string
  query?: Record<string, unknown>
  body?: unknown
}) => Promise<RequestResult>

function lowLevelPost(client: unknown): LowLevelPost {
  const hey = (client as { _client?: { post?: unknown } } | null | undefined)?._client
  if (!hey || typeof hey.post !== "function") {
    throw new Error("opencode client does not expose a low-level post method")
  }
  return (hey.post as LowLevelPost).bind(hey)
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error).slice(0, 200)
  } catch {
    return String(error)
  }
}

async function post(api: OpenCodeApi, path: string, body?: unknown): Promise<void> {
  const send = lowLevelPost(api.client)
  const res = await send({
    url: path,
    ...(api.directory ? { query: { directory: api.directory } } : {}),
    ...(body !== undefined ? { body } : {}),
  })
  if (res?.error) {
    throw new Error(`OpenCode API ${path} failed: ${describeError(res.error)}`)
  }
  if (res?.response && res.response.ok === false) {
    throw new Error(`OpenCode API ${path} returned HTTP ${res.response.status}`)
  }
}

export function replyQuestion(api: OpenCodeApi, requestID: string, answers: string[][]): Promise<void> {
  return post(api, `/question/${encodeURIComponent(requestID)}/reply`, { answers })
}

export function rejectQuestion(api: OpenCodeApi, requestID: string): Promise<void> {
  return post(api, `/question/${encodeURIComponent(requestID)}/reject`)
}

export function replyPermission(api: OpenCodeApi, requestID: string, reply: "once" | "always" | "reject"): Promise<void> {
  return post(api, `/permission/${encodeURIComponent(requestID)}/reply`, { reply })
}

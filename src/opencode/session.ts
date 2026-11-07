import type { SessionInfo } from "../notifier.js"

/**
 * Normalize a session returned by OpenCode 1.x or 2.x. OpenCode 1 exposes
 * `directory` and `summary`; 2.x exposes `location.directory` and has no
 * summary, but keeps the parent chain that subagent notifications rely on.
 */
export function normalizeSessionInfo(raw: unknown): SessionInfo {
  const session = record(raw)
  const id = stringField(session?.id)
  if (!id) throw new Error("OpenCode returned a session without an id")

  const location = record(session?.location)
  const directory = stringField(session?.directory) ?? stringField(location?.directory) ?? ""
  const title = stringField(session?.title) ?? id
  const parentID = stringField(session?.parentID)
  const summary = normalizeSummary(session?.summary)

  return {
    id,
    title,
    directory,
    ...(parentID ? { parentID } : {}),
    ...(summary ? { summary } : {}),
  }
}

function normalizeSummary(raw: unknown): SessionInfo["summary"] | undefined {
  const summary = record(raw)
  const files = numberField(summary?.files)
  const additions = numberField(summary?.additions)
  const deletions = numberField(summary?.deletions)
  if (files === undefined || additions === undefined || deletions === undefined) return undefined
  return { files, additions, deletions }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

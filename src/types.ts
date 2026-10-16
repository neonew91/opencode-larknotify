/**
 * Shared domain types used by the plugin, the IPC layer and the broker.
 *
 * Keeping these free of any runtime dependency (no Feishu SDK, no bun:sqlite)
 * lets the pure routing/notification logic stay unit-testable.
 */

export interface SummaryInfo {
  files: number
  additions: number
  deletions: number
}

export interface IdleNotification {
  kind: "idle"
  project: string
  session: string
  durationMs: number
  summary?: SummaryInfo
}

export interface PermissionNotification {
  kind: "permission"
  project: string
  session: string
  childSession?: string
  permission: string
  patterns: readonly string[]
}

export interface QuestionNotificationItem {
  header: string
  question: string
  /** Option labels. Kept as plain strings so older brokers keep rendering them. */
  options: readonly string[]
  /**
   * `label — description` per option, added after protocol 2. Absent when no
   * option carries a description; a broker that predates it ignores the field
   * and falls back to `options`.
   */
  optionDetails?: readonly string[]
}

export interface QuestionNotification {
  kind: "question"
  project: string
  session: string
  childSession?: string
  questions: readonly QuestionNotificationItem[]
}

export type Notification = IdleNotification | PermissionNotification | QuestionNotification

export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionSpec {
  header: string
  question: string
  options: QuestionOption[]
  multiple: boolean
  /** OpenCode's question allows a free-form answer in addition to the options. */
  custom?: boolean
}

/** A request that blocks an OpenCode session until the user decides in Feishu. */
export type DecisionRequest =
  | {
      kind: "question"
      requestID: string
      instanceID: string
      sessionID: string
      directory: string
      project: string
      session: string
      childSession?: string
      questions: QuestionSpec[]
    }
  | {
      kind: "permission"
      requestID: string
      instanceID: string
      sessionID: string
      directory: string
      project: string
      session: string
      childSession?: string
      permission: string
      patterns: string[]
    }

/** Instruction sent back to the originating plugin once the user has decided. */
export type Reply =
  | { kind: "question"; answers: string[][] }
  | { kind: "question-reject" }
  | { kind: "permission"; reply: "once" | "reject" }

export type RequestKind = DecisionRequest["kind"]

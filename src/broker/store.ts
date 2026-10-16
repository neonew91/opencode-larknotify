import type { Database } from "bun:sqlite"
import type { DecisionRequest, RequestKind } from "../types.js"

export type ActionStatus = "pending" | "processing" | "completed" | "rejected" | "expired" | "stale"

export interface ActionRecord {
  actionToken: string
  instanceID: string
  connectionID: string | null
  requestID: string
  requestKind: RequestKind
  sessionID: string
  directory: string
  allowedOpenIds: string[]
  request: DecisionRequest
  feishuMessageID: string | null
  status: ActionStatus
  operatorID: string | null
  createdAt: number
  updatedAt: number
  expiresAt: number
}

export interface CreateActionInput {
  actionToken: string
  connectionID: string
  request: DecisionRequest
  allowedOpenIds: string[]
  createdAt: number
  expiresAt: number
}

export type ClaimResult =
  | { ok: true; row: ActionRecord }
  | { ok: false; reason: "notfound" | "expired" | "already"; row?: ActionRecord }

interface Row {
  action_token: string
  instance_id: string
  connection_id: string | null
  request_id: string
  request_kind: string
  session_id: string
  directory: string
  allowed_open_ids: string
  payload: string
  feishu_message_id: string | null
  status: string
  operator_id: string | null
  created_at: number
  updated_at: number
  expires_at: number
}

const TERMINAL: ActionStatus[] = ["completed", "rejected", "expired", "stale"]

export function createSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS actions (
      action_token TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      connection_id TEXT,
      request_id TEXT NOT NULL,
      request_kind TEXT NOT NULL,
      session_id TEXT NOT NULL,
      directory TEXT NOT NULL,
      allowed_open_ids TEXT NOT NULL,
      payload TEXT NOT NULL,
      feishu_message_id TEXT,
      status TEXT NOT NULL,
      operator_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_actions_request ON actions(request_id);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_actions_connection ON actions(connection_id);`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);`)
}

function toRecord(row: Row): ActionRecord {
  return {
    actionToken: row.action_token,
    instanceID: row.instance_id,
    connectionID: row.connection_id,
    requestID: row.request_id,
    requestKind: row.request_kind as RequestKind,
    sessionID: row.session_id,
    directory: row.directory,
    allowedOpenIds: JSON.parse(row.allowed_open_ids) as string[],
    request: JSON.parse(row.payload) as DecisionRequest,
    feishuMessageID: row.feishu_message_id,
    status: row.status as ActionStatus,
    operatorID: row.operator_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  }
}

export class RouteStore {
  constructor(private readonly db: Database) {
    createSchema(db)
  }

  create(input: CreateActionInput): void {
    this.db
      .query(
        `INSERT INTO actions (
          action_token, instance_id, connection_id, request_id, request_kind,
          session_id, directory, allowed_open_ids, payload, feishu_message_id,
          status, operator_id, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, ?, ?, ?)`,
      )
      .run(
        input.actionToken,
        input.request.instanceID,
        input.connectionID,
        input.request.requestID,
        input.request.kind,
        input.request.sessionID,
        input.request.directory,
        JSON.stringify(input.allowedOpenIds),
        JSON.stringify(input.request),
        input.createdAt,
        input.createdAt,
        input.expiresAt,
      )
  }

  get(actionToken: string): ActionRecord | undefined {
    const row = this.db.query(`SELECT * FROM actions WHERE action_token = ?`).get(actionToken) as Row | null
    return row ? toRecord(row) : undefined
  }

  findByRequest(requestID: string): ActionRecord | undefined {
    const row = this.db
      .query(`SELECT * FROM actions WHERE request_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(requestID) as Row | null
    return row ? toRecord(row) : undefined
  }

  attachMessage(actionToken: string, feishuMessageID: string, now: number): void {
    this.db
      .query(`UPDATE actions SET feishu_message_id = ?, updated_at = ? WHERE action_token = ?`)
      .run(feishuMessageID, now, actionToken)
  }

  /** Atomically move a pending action to processing. Expired or already-handled actions fail. */
  claim(actionToken: string, operatorID: string, now: number): ClaimResult {
    const run = this.db.transaction((): ClaimResult => {
      const raw = this.db.query(`SELECT * FROM actions WHERE action_token = ?`).get(actionToken) as Row | null
      if (!raw) return { ok: false, reason: "notfound" }
      const record = toRecord(raw)
      if (record.status !== "pending") return { ok: false, reason: "already", row: record }
      if (record.expiresAt <= now) {
        this.db
          .query(`UPDATE actions SET status = 'expired', updated_at = ? WHERE action_token = ? AND status = 'pending'`)
          .run(now, actionToken)
        return { ok: false, reason: "expired", row: { ...record, status: "expired" } }
      }
      this.db
        .query(
          `UPDATE actions SET status = 'processing', operator_id = ?, updated_at = ? WHERE action_token = ? AND status = 'pending'`,
        )
        .run(operatorID, now, actionToken)
      const changed = (this.db.query(`SELECT changes() AS c`).get() as { c: number }).c
      if (changed === 1) {
        return { ok: true, row: { ...record, status: "processing", operatorID } }
      }
      return { ok: false, reason: "already", row: record }
    })
    return run()
  }

  settle(actionToken: string, status: Extract<ActionStatus, "completed" | "rejected" | "stale" | "expired">, now: number): void {
    this.db.query(`UPDATE actions SET status = ?, updated_at = ? WHERE action_token = ?`).run(status, now, actionToken)
  }

  /**
   * User answered inside OpenCode: retract a card that is still waiting for input.
   * A `processing` action is being written back from Feishu, so an OpenCode
   * reply for it is normally the echo of that write-back and must not retract it.
   */
  resolveLocally(requestID: string, now: number): ActionRecord | undefined {
    const row = this.db
      .query(`SELECT * FROM actions WHERE request_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`)
      .get(requestID) as Row | null
    if (!row) return undefined
    this.db.query(`UPDATE actions SET status = 'stale', updated_at = ? WHERE action_token = ?`).run(now, row.action_token)
    return { ...toRecord(row), status: "stale" }
  }

  expireDue(now: number): ActionRecord[] {
    const rows = this.db
      .query(`SELECT * FROM actions WHERE status = 'pending' AND expires_at <= ?`)
      .all(now) as Row[]
    if (rows.length === 0) return []
    this.db.query(`UPDATE actions SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at <= ?`).run(now, now)
    return rows.map((row) => ({ ...toRecord(row), status: "expired" as const }))
  }

  markConnectionStale(connectionID: string, now: number): ActionRecord[] {
    const rows = this.db
      .query(`SELECT * FROM actions WHERE connection_id = ? AND status IN ('pending', 'processing')`)
      .all(connectionID) as Row[]
    if (rows.length === 0) return []
    this.db
      .query(`UPDATE actions SET status = 'stale', updated_at = ? WHERE connection_id = ? AND status IN ('pending', 'processing')`)
      .run(now, connectionID)
    return rows.map((row) => ({ ...toRecord(row), status: "stale" as const }))
  }

  activeCount(): number {
    const row = this.db
      .query(`SELECT COUNT(*) AS c FROM actions WHERE status IN ('pending', 'processing')`)
      .get() as { c: number }
    return row.c
  }

  /** Retire every open action; used at startup because old connections can never return. */
  markAllOpenStale(now: number): ActionRecord[] {
    const rows = this.db.query(`SELECT * FROM actions WHERE status IN ('pending', 'processing')`).all() as Row[]
    if (rows.length === 0) return []
    this.db.query(`UPDATE actions SET status = 'stale', updated_at = ? WHERE status IN ('pending', 'processing')`).run(now)
    return rows.map((row) => ({ ...toRecord(row), status: "stale" as const }))
  }

  purgeTerminalBefore(cutoff: number): void {
    this.db
      .query(`DELETE FROM actions WHERE status IN (${TERMINAL.map(() => "?").join(", ")}) AND updated_at < ?`)
      .run(...TERMINAL, cutoff)
  }
}

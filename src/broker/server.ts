import { randomUUID } from "node:crypto"
import { Database } from "bun:sqlite"
import * as lark from "@larksuiteoapi/node-sdk"
import type { BrokerConfig } from "../options.js"
import type { DecisionRequest, Reply } from "../types.js"
import { createFeishuPayload } from "../feishu.js"
import { isAllowedOperator } from "../decision.js"
import {
  PROTOCOL_VERSION,
  createNdjsonDecoder,
  encodeMessage,
  isCompatibleProtocol,
  type BrokerMessage,
  type PluginMessage,
} from "../ipc/protocol.js"
import { RouteStore, type ActionRecord } from "./store.js"
import { buildDecisionCard, buildResolvedCard, escapeMarkdown, parseActionValue, parseFormText } from "./card.js"
import { advance, initialProgress, toWizardAction, type WizardProgress } from "./wizard.js"

type Level = "debug" | "info" | "warn" | "error"

function log(level: Level, message: string, extra?: unknown): void {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`
  if (extra !== undefined) console[level === "debug" ? "log" : level](line, extra)
  else console[level === "debug" ? "log" : level](line)
}

interface ApplyWaiter {
  resolve: (result: { ok: boolean; error?: string }) => void
  timer: ReturnType<typeof setTimeout>
}

interface Connection {
  id: string
  socket: { write: (data: string) => void; end: () => void; data?: unknown }
  decoder: ReturnType<typeof createNdjsonDecoder>
  instanceID?: string
  helloDone: boolean
  applyWaiters: Map<string, ApplyWaiter>
}

export interface BrokerHandle {
  shutdown: () => void
}

export function startBroker(config: BrokerConfig, token: string, dbPath: string): BrokerHandle {
  const store = new RouteStore(new Database(dbPath))
  const connections = new Map<string, Connection>()
  const seenEvents = new Set<string>()
  // Wizard progress of multi-step question cards, keyed by action token. Kept in
  // memory: connection IDs are per-process, so a broker restart orphans every
  // open decision anyway (they are marked stale at startup).
  const progress = new Map<string, WizardProgress>()
  // Decisions being written back from Feishu for which OpenCode also reported a
  // reply. On success that reply was our own echo; on failure it means the user
  // answered in the terminal first.
  const answeredLocally = new Set<string>()
  // Pending card patches per message. Patches of one card are sent one at a time
  // so the state we set last is the state that lands last.
  const cardQueues = new Map<string, Promise<void>>()
  let lastActivity = Date.now()

  const larkClient = new lark.Client({ appId: config.appId, appSecret: config.appSecret, domain: config.domain })
  const wsClient = new lark.WSClient({ appId: config.appId, appSecret: config.appSecret, domain: config.domain })

  function touch(): void {
    lastActivity = Date.now()
  }

  function sendTo(conn: Connection, message: BrokerMessage): void {
    try {
      conn.socket.write(encodeMessage(message))
    } catch (error) {
      log("error", `failed to write to connection ${conn.id}`, error)
    }
  }

  async function sendCard(card: Record<string, unknown>): Promise<string | undefined> {
    const res = (await larkClient.im.message.create({
      params: { receive_id_type: config.receiveIdType },
      data: {
        receive_id: config.receiveId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    })) as { data?: { message_id?: string }; message_id?: string }
    return res?.data?.message_id ?? res?.message_id
  }

  function updateCard(messageID: string, card: Record<string, unknown>): Promise<void> {
    const previous = cardQueues.get(messageID) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => {
        await larkClient.im.message.patch({
          path: { message_id: messageID },
          data: { content: JSON.stringify(card) },
        })
      })
    cardQueues.set(messageID, next)
    void next
      .catch(() => {})
      .finally(() => {
        if (cardQueues.get(messageID) === next) cardQueues.delete(messageID)
      })
    return next
  }

  function contextLines(record: ActionRecord): string[] {
    const lines = [
      `**项目**：${escapeMarkdown(record.request.project, 120)}`,
      `**会话**：${escapeMarkdown(record.request.session, 240)}`,
    ]
    if (record.request.childSession) lines.push(`**子会话**：${escapeMarkdown(record.request.childSession, 240)}`)
    return lines
  }

  function resolvedCard(record: ActionRecord, title: string, lines: string[]): Record<string, unknown> {
    return buildResolvedCard({ title, template: "grey", lines: [...contextLines(record), ...lines] })
  }

  /** The card that reflects the current state of an action. */
  function statusCard(record: ActionRecord): Record<string, unknown> {
    switch (record.status) {
      case "pending":
        return buildDecisionCard(record.request, record.actionToken, progress.get(record.actionToken))
      case "processing":
        return resolvedCard(record, "[OpenCode] 处理中", ["正在处理你的选择…"])
      case "completed":
        return resolvedCard(record, "[OpenCode] 已处理", ["该决策已处理"])
      case "expired":
        return resolvedCard(record, "[OpenCode] 决策已过期", ["该请求已超时，请回到 OpenCode 处理"])
      default:
        return resolvedCard(record, "[OpenCode] 决策已失效", ["该决策已失效，请回到 OpenCode 处理"])
    }
  }

  async function retractCard(record: ActionRecord, title: string, lines: string[]): Promise<void> {
    progress.delete(record.actionToken)
    if (!record.feishuMessageID) return
    try {
      await updateCard(record.feishuMessageID, resolvedCard(record, title, lines))
    } catch (error) {
      log("warn", `failed to update card for ${record.actionToken}`, error)
    }
  }

  function resultLines(record: ActionRecord, reply: Reply): string[] {
    if (reply.kind === "permission") return [`你的选择：${reply.reply === "once" ? "允许一次" : "拒绝"}`]
    if (reply.kind === "question-reject") return ["你的选择：已拒绝"]
    const questions = record.request.kind === "question" ? record.request.questions : []
    if (questions.length <= 1) return [`你的选择：${escapeMarkdown((reply.answers[0] ?? []).join("、"), 600)}`]
    return [
      "你的选择：",
      ...reply.answers.map((group, index) => {
        const question = questions[index]
        const title = question?.header || question?.question || `问题 ${index + 1}`
        return `${index + 1}. **${escapeMarkdown(title, 60)}**：${escapeMarkdown(group.join("、"), 600)}`
      }),
    ]
  }

  async function dispatchApply(conn: Connection, record: ActionRecord, reply: Reply): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        conn.applyWaiters.delete(id)
        resolve({ ok: false, error: "apply timed out" })
      }, 15_000)
      conn.applyWaiters.set(id, { resolve, timer })
      sendTo(conn, { type: "apply", id, requestID: record.requestID, requestKind: record.requestKind, reply })
    })
  }

  function respond(card: Record<string, unknown>, toast?: { type: string; content: string }): Record<string, unknown> {
    return { ...(toast ? { toast } : {}), card: { type: "raw", data: card } }
  }

  function invalidCard(): Record<string, unknown> {
    return buildResolvedCard({ title: "[OpenCode] 决策已失效", template: "grey", lines: ["该决策已失效，请回到 OpenCode 处理"] })
  }

  /**
   * Handle a card click synchronously. Wizard steps only update in-memory
   * progress and return the next card; the final answer is claimed atomically
   * and written back asynchronously. Always returning a card keeps the Feishu
   * client from rolling back to the original card.
   */
  function onCardAction(data: Record<string, unknown>): Record<string, unknown> {
    touch()
    const eventId = stringValue(data.event_id) ?? stringValue((data.header as Record<string, unknown> | undefined)?.event_id)
    const duplicate = eventId !== undefined && seenEvents.has(eventId)
    if (eventId && !duplicate) {
      seenEvents.add(eventId)
      if (seenEvents.size > 5_000) seenEvents.delete(seenEvents.values().next().value as string)
    }

    const operatorID = extractOperator(data)
    const action = parseActionValue(pickActionValue(data))
    if (!operatorID || !action) {
      log("warn", "ignoring card callback without operator or action value")
      return respond(invalidCard())
    }
    const record = store.get(action.t)
    if (!record) {
      log("warn", `callback for unknown action token ${action.t}`)
      return respond(invalidCard())
    }
    if (!isAllowedOperator(operatorID, record.allowedOpenIds)) {
      log("warn", `operator ${operatorID} is not allowed to act on ${action.t}`)
      return respond(statusCard(record), { type: "warning", content: "你无权处理该决策" })
    }
    if (duplicate) return respond(statusCard(record))
    log("info", `callback accepted: token=${action.t} kind=${action.k} step=${action.s ?? "-"} operator=${operatorID} event=${eventId ?? "?"}`)

    if (record.status === "pending" && record.expiresAt <= Date.now()) {
      store.settle(action.t, "expired", Date.now())
      progress.delete(action.t)
      return respond(statusCard({ ...record, status: "expired" }))
    }
    if (record.status !== "pending") {
      progress.delete(action.t)
      return respond(statusCard(record))
    }

    if (record.request.kind === "permission") {
      if (action.k !== "p" || !action.r) return respond(statusCard(record), { type: "warning", content: "无法识别的操作" })
      return finalize(record, operatorID, { kind: "permission", reply: action.r })
    }

    const questions = record.request.questions
    const current = progress.get(action.t) ?? initialProgress(questions)
    const wizardAction = toWizardAction(action, action.k === "qc" ? parseFormText(data, "answer") : undefined)
    if (!wizardAction) {
      return respond(buildDecisionCard(record.request, action.t, current), { type: "warning", content: "无法识别的操作" })
    }

    const outcome = advance(questions, current, wizardAction)
    if (outcome.type === "render") {
      progress.set(action.t, outcome.progress)
      log("info", `wizard ${action.t}: step=${outcome.progress.step}/${questions.length}${outcome.notice ? ` notice=${outcome.notice}` : ""}`)
      return respond(
        buildDecisionCard(record.request, action.t, outcome.progress),
        outcome.notice ? { type: "warning", content: outcome.notice } : undefined,
      )
    }

    progress.delete(action.t)
    const reply: Reply = outcome.type === "reject" ? { kind: "question-reject" } : { kind: "question", answers: outcome.answers }
    return finalize(record, operatorID, reply)
  }

  function finalize(record: ActionRecord, operatorID: string, reply: Reply): Record<string, unknown> {
    const claim = store.claim(record.actionToken, operatorID, Date.now())
    log("info", `claim ${record.actionToken}: ${claim.ok ? "ok" : claim.reason}`)
    if (!claim.ok) return respond(statusCard(claim.row ?? record))
    completeDecision(claim.row, reply).catch((error) => log("error", `complete ${record.actionToken} failed: ${describe(error)}`))
    return respond(statusCard(claim.row))
  }

  async function completeDecision(row: ActionRecord, reply: Reply): Promise<void> {
    const conn = connections.get(row.connectionID ?? "")
    log(
      "info",
      `dispatch ${row.actionToken} -> conn=${row.connectionID ?? "none"} found=${Boolean(conn)} hello=${conn?.helloDone ?? false} connections=${connections.size}`,
    )
    if (!conn || !conn.helloDone) {
      answeredLocally.delete(row.actionToken)
      store.settle(row.actionToken, "stale", Date.now())
      await retractCard(row, "[OpenCode] 会话已失效", ["发起该请求的 OpenCode 会话已退出"])
      return
    }

    const result = await dispatchApply(conn, row, reply)
    const answeredInTerminal = answeredLocally.delete(row.actionToken)
    log("info", `apply ${row.actionToken}: ok=${result.ok}${result.error ? ` error=${result.error}` : ""}`)
    if (result.ok) {
      store.settle(row.actionToken, "completed", Date.now())
      await retractCard(row, "[OpenCode] 已处理", resultLines(row, reply))
    } else if (answeredInTerminal) {
      store.settle(row.actionToken, "stale", Date.now())
      await retractCard(row, "[OpenCode] 已在 OpenCode 处理", ["该请求已在终端内完成"])
    } else {
      store.settle(row.actionToken, "stale", Date.now())
      await retractCard(row, "[OpenCode] 会话已失效", [result.error ?? "回写 OpenCode 失败"])
    }
  }

  function onPluginMessage(conn: Connection, message: PluginMessage): void {
    touch()
    switch (message.type) {
      case "hello": {
        const protocolOk = isCompatibleProtocol(message.protocol)
        const tokenOk = message.token === token
        const ok = protocolOk && tokenOk
        conn.helloDone = ok
        conn.instanceID = message.instanceID
        log("info", `hello conn=${conn.id} instance=${message.instanceID} protocol=${message.protocol} ok=${ok}`)
        const error = !protocolOk ? `unsupported protocol ${message.protocol}` : !tokenOk ? "token mismatch" : undefined
        sendTo(conn, {
          type: "welcome",
          ok,
          protocol: PROTOCOL_VERSION,
          brokerPid: process.pid,
          ...(error ? { error } : {}),
        })
        if (!ok) conn.socket.end()
        return
      }
      case "notify": {
        if (!conn.helloDone) return
        void sendNotification(conn, message.id, message.notification)
        return
      }
      case "decision": {
        if (!conn.helloDone) return
        void createDecision(conn, message.id, message.request)
        return
      }
      case "resolve": {
        if (!conn.helloDone) return
        const latest = store.findByRequest(message.requestID)
        if (latest?.status === "processing") {
          // The answer from Feishu is being written back, so this reply is
          // normally our own echo. completeDecision decides the final card.
          answeredLocally.add(latest.actionToken)
          log("info", `resolve ${message.requestID}: ${latest.actionToken} is being written back from Feishu; card kept`)
          return
        }
        const record = store.resolveLocally(message.requestID, Date.now())
        if (record) {
          log("info", `resolve ${message.requestID}: answered in OpenCode; retracting ${record.actionToken}`)
          void retractCard(record, "[OpenCode] 已在 OpenCode 处理", ["该请求已在终端内完成"])
        }
        return
      }
      case "apply-result": {
        const waiter = conn.applyWaiters.get(message.id)
        if (!waiter) return
        clearTimeout(waiter.timer)
        conn.applyWaiters.delete(message.id)
        waiter.resolve({ ok: message.ok, ...(message.error ? { error: message.error } : {}) })
        return
      }
      case "pong":
        return
    }
  }

  async function sendNotification(conn: Connection, id: string, notification: Parameters<typeof createFeishuPayload>[0]): Promise<void> {
    try {
      const payload = createFeishuPayload(notification)
      const card = (payload as { card: Record<string, unknown> }).card
      await sendCard(card)
      sendTo(conn, { type: "result", id, ok: true })
    } catch (error) {
      sendTo(conn, { type: "result", id, ok: false, error: describe(error) })
    }
  }

  async function createDecision(conn: Connection, id: string, request: DecisionRequest): Promise<void> {
    const actionToken = randomUUID()
    const now = Date.now()
    try {
      store.create({
        actionToken,
        connectionID: conn.id,
        request,
        allowedOpenIds: config.allowedOpenIds,
        createdAt: now,
        expiresAt: now + config.actionTtlMs,
      })
      const card = buildDecisionCard(request, actionToken)
      const messageID = await sendCard(card)
      if (messageID) store.attachMessage(actionToken, messageID, Date.now())
      log("info", `decision ${actionToken} (${request.kind}) sent from conn=${conn.id} messageId=${messageID ?? "none"}`)
      sendTo(conn, { type: "result", id, ok: true })
    } catch (error) {
      store.settle(actionToken, "stale", Date.now())
      log("error", `decision ${actionToken} send failed: ${describe(error)}`)
      sendTo(conn, { type: "result", id, ok: false, error: describe(error) })
    }
  }

  const listen = (globalThis as { Bun?: { listen: (opts: unknown) => { stop: () => void } } }).Bun?.listen
  if (!listen) throw new Error("Bun runtime is required to run the broker")

  const server = listen({
    unix: config.socketPath,
    socket: {
      open: (socket: Connection["socket"]) => {
        const id = randomUUID()
        const conn: Connection = { id, socket, decoder: createNdjsonDecoder(), helloDone: false, applyWaiters: new Map() }
        socket.data = id
        connections.set(id, conn)
        touch()
        log("info", `connection opened: ${id} (total ${connections.size})`)
      },
      data: (socket: Connection["socket"], data: Buffer) => {
        const conn = connections.get(String(socket.data))
        if (!conn) return
        for (const parsed of conn.decoder.push(data.toString("utf8"))) {
          onPluginMessage(conn, parsed as PluginMessage)
        }
      },
      close: (socket: Connection["socket"]) => {
        const connID = String(socket.data)
        connections.delete(connID)
        const stale = store.markConnectionStale(connID, Date.now())
        log("info", `connection closed: ${connID} (remaining ${connections.size}) staled=${stale.length}`)
        for (const record of stale) {
          void retractCard(record, "[OpenCode] 会话已失效", ["发起该请求的 OpenCode 会话已退出"])
        }
      },
      error: (_socket: Connection["socket"], error: Error) => log("error", "socket error", error),
    },
  })

  wsClient.start({
    eventDispatcher: new lark.EventDispatcher({}).register({
      "card.action.trigger": async (data: Record<string, unknown>) => {
        try {
          return onCardAction(data)
        } catch (error) {
          log("error", `card action failed: ${describe(error)}`)
          return { toast: { type: "error", content: "处理失败，请回到 OpenCode 处理" } }
        }
      },
    }),
  })

  const expireTimer = setInterval(() => {
    const expired = store.expireDue(Date.now())
    for (const record of expired) {
      void retractCard(record, "[OpenCode] 决策已过期", ["该请求已超时，请回到 OpenCode 处理"])
    }
    store.purgeTerminalBefore(Date.now() - 24 * 60 * 60 * 1000)
  }, 30_000)

  const idleTimer = setInterval(() => {
    if (connections.size === 0 && store.activeCount() === 0 && Date.now() - lastActivity > config.idleShutdownMs) {
      log("info", "broker idle; shutting down")
      handle.shutdown()
    }
  }, 60_000)

  const handle: BrokerHandle = {
    shutdown: () => {
      clearInterval(expireTimer)
      clearInterval(idleTimer)
      try {
        server.stop()
      } catch {
        // ignore
      }
      process.exit(0)
    },
  }

  process.on("SIGTERM", () => handle.shutdown())
  process.on("SIGINT", () => handle.shutdown())

  // Connection IDs are per-process, so decisions left open by a previous broker
  // can never be routed back. Retire them so their cards stop accepting input.
  const orphaned = store.markAllOpenStale(Date.now())
  if (orphaned.length > 0) log("info", `retired ${orphaned.length} decision(s) left open by a previous broker`)
  for (const record of orphaned) {
    void retractCard(record, "[OpenCode] 决策已失效", ["通知服务已重启，该决策已失效，请回到 OpenCode 处理"])
  }

  log("info", `feishu broker listening on ${config.socketPath} (pid ${process.pid})`)
  return handle
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function extractOperator(data: Record<string, unknown>): string | undefined {
  const direct = stringValue(data.operator_id) ?? stringValue(data.open_id)
  if (direct) return direct
  const operator = data.operator as Record<string, unknown> | undefined
  return stringValue(operator?.open_id) ?? stringValue(operator?.operator_id)
}

function pickActionValue(data: Record<string, unknown>): unknown {
  if (data.action_value !== undefined) return data.action_value
  const action = data.action as Record<string, unknown> | undefined
  return action?.value
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

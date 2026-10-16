import { createHmac } from "node:crypto"

import type { Notification, QuestionNotification, QuestionNotificationItem } from "./types.js"

export type { Notification } from "./types.js"

/** Plugins loaded before protocol 2 send a single question as top-level fields. */
function questionItems(notification: QuestionNotification): readonly QuestionNotificationItem[] {
  if (Array.isArray(notification.questions)) return notification.questions
  const legacy = notification as unknown as { header?: unknown; question?: unknown; options?: unknown }
  const header = typeof legacy.header === "string" ? legacy.header : ""
  const question = typeof legacy.question === "string" ? legacy.question : ""
  const options = Array.isArray(legacy.options) ? legacy.options.filter((item): item is string => typeof item === "string") : []
  return header || question ? [{ header, question, options }] : []
}

export interface FeishuConfig {
  webhook: string
  secret?: string
  atUserID?: string
  timeoutMs?: number
  maxAttempts?: number
}

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface SendDependencies {
  fetch?: Fetcher
  now?: () => number
  sleep?: (durationMs: number) => Promise<void>
}

interface FeishuResponse {
  code?: number
  msg?: string
  StatusCode?: number
  StatusMessage?: string
}

class DeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
    this.name = "FeishuDeliveryError"
  }
}

export function createSignature(timestamp: string, secret: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64")
}

export function createFeishuPayload(notification: Notification, atUserID?: string): Record<string, unknown> {
  const lines = [
    `**项目**：${markdown(notification.project, 120)}`,
    `**会话**：${markdown(notification.session, 240)}`,
  ]

  let title: string
  let template: string

  if (notification.kind === "idle") {
    title = "[OpenCode] 任务已结束"
    template = "green"
    lines.push(`**耗时**：${formatDuration(notification.durationMs)}`)
    lines.push("**状态**：等待新指令")
    if (notification.summary && notification.summary.files > 0) {
      lines.push(
        `**变更**：${notification.summary.files} 个文件，+${notification.summary.additions} / -${notification.summary.deletions}`,
      )
    }
  } else if (notification.kind === "permission") {
    title = "[OpenCode] 等待权限确认"
    template = "orange"
    if (notification.childSession) {
      lines.push(`**子会话**：${markdown(notification.childSession, 240)}`)
    }
    lines.push(`**权限**：${markdown(notification.permission, 120)}`)
    lines.push(`**操作**：${markdown(notification.patterns.join(" | ") || "未提供", 1_200)}`)
    lines.push("**处理**：请回到 OpenCode 选择 once / always / reject")
  } else {
    title = "[OpenCode] 等待你的决策"
    template = "blue"
    if (notification.childSession) {
      lines.push(`**子会话**：${markdown(notification.childSession, 240)}`)
    }
    const items = questionItems(notification)
    const total = items.length
    items.forEach((item, index) => {
      const label = total > 1 ? `**问题 ${index + 1}/${total}**` : "**问题**"
      lines.push(`${label}：${markdown(item.question || item.header, 1_200)}`)
      // Prefer the option descriptions when the sending plugin provides them.
      const options = item.optionDetails ?? item.options
      if (options.length > 0) {
        const rendered = options.map((option, optionIndex) => `${optionIndex + 1}. ${markdown(option, 400)}`).join("\n")
        lines.push(`**候选**：\n${rendered}`)
      }
    })
    lines.push("**处理**：请回到 OpenCode 作答")
  }

  if (atUserID) lines.push(`<at id=${atUserID}></at>`)

  return {
    msg_type: "interactive",
    card: {
      schema: "2.0",
      config: { update_multi: true },
      header: {
        template,
        title: {
          tag: "plain_text",
          content: title,
        },
      },
      body: {
        direction: "vertical",
        padding: "12px 12px 12px 12px",
        elements: [
          {
            tag: "markdown",
            content: lines.join("\n"),
            text_align: "left",
            text_size: "normal_v2",
          },
        ],
      },
    },
  }
}

export async function sendFeishu(
  notification: Notification,
  config: FeishuConfig,
  dependencies: SendDependencies = {},
): Promise<void> {
  const fetcher = dependencies.fetch ?? globalThis.fetch
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? ((durationMs: number) => new Promise((resolve) => setTimeout(resolve, durationMs)))
  const maxAttempts = Math.max(1, Math.floor(config.maxAttempts ?? 3))
  const timeoutMs = Math.max(1, Math.floor(config.timeoutMs ?? 5_000))
  const payload = createFeishuPayload(notification, config.atUserID)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const timestamp = Math.floor(now() / 1_000).toString()
      const body = {
        ...(config.secret ? { timestamp, sign: createSignature(timestamp, config.secret) } : {}),
        ...payload,
      }
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      let response: Response
      try {
        response = await fetcher(config.webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch {
        throw new DeliveryError("Feishu webhook request failed", true)
      } finally {
        clearTimeout(timeout)
      }

      if (!response.ok) {
        throw new DeliveryError(
          `Feishu webhook returned HTTP ${response.status}`,
          response.status === 429 || response.status >= 500,
        )
      }

      let result: FeishuResponse
      try {
        result = (await response.json()) as FeishuResponse
      } catch {
        throw new DeliveryError("Feishu webhook returned invalid JSON", true)
      }

      if (result.code === 0 || result.StatusCode === 0) return
      const code = result.code ?? result.StatusCode ?? "unknown"
      const message = result.msg ?? result.StatusMessage ?? "unknown error"
      throw new DeliveryError(`Feishu webhook rejected the message (${code}: ${message})`, false)
    } catch (error) {
      const failure = error instanceof DeliveryError ? error : new DeliveryError("Feishu webhook request failed", true)
      if (!failure.retryable || attempt === maxAttempts) throw failure
      await sleep(250 * 2 ** (attempt - 1))
    }
  }
}

function markdown(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  const truncated = normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
  return truncated.replace(/([\\`*_[\]~>])/g, "\\$1") || "未命名"
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`
}

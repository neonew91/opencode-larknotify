import type { DecisionRequest, QuestionOption, QuestionSpec } from "../types.js"
import { initialProgress, isReviewStep, type WizardProgress } from "./wizard.js"

/**
 * Button callback value. `t` is the one-time action token; `s` is the wizard
 * step the button was rendered for (absent on cards sent before steps existed).
 *
 * q  pick option `c` (single choice)     qt toggle option `c` (multi-select)
 * qn confirm the multi-select step       qc submit the custom answer form
 * qb back to the previous question       qs submit all answers (review step)
 * qx reject the question                 p  permission reply `r`
 */
export interface CardActionValue {
  t: string
  k: "q" | "qt" | "qn" | "qc" | "qb" | "qs" | "qx" | "p"
  s?: number
  c?: number
  r?: "once" | "reject"
}

const ACTION_KINDS: ReadonlySet<string> = new Set(["q", "qt", "qn", "qc", "qb", "qs", "qx", "p"])

/** Per-option description budget inside the markdown option list. */
const OPTION_TEXT_LIMIT = 400
/** Total budget of the option list, so a card with very long options still fits. */
const OPTIONS_BLOCK_LIMIT = 6_000
/** Option label budget on a button. Buttons are single-line, so keep it short. */
const BUTTON_LABEL_LIMIT = 60
const OPTIONS_TRUNCATED_NOTICE = "（选项说明过长，已省略部分内容，完整内容请回 OpenCode 查看）"

export function escapeMarkdown(value: string, limit: number): string {
  return plainText(value, limit).replace(/([\\`*_[\]~>])/g, "\\$1")
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/**
 * Text for a `plain_text` field (button labels, placeholders). Normalizes
 * whitespace and clips, but must never escape markdown: a button would then
 * show the backslashes verbatim.
 */
export function plainText(value: string, limit: number): string {
  const normalized = normalize(value)
  if (!normalized) return "未命名"
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

const esc = escapeMarkdown

function button(content: string, type: string, value: CardActionValue, width = "default"): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content },
    type,
    width,
    size: "medium",
    behaviors: [{ type: "callback", value }],
  }
}

/** A free-form input + submit button, used when the question allows a custom answer. */
function customForm(actionToken: string, step: number): Record<string, unknown> {
  return {
    tag: "form",
    name: "custom_form",
    elements: [
      {
        tag: "input",
        name: "answer",
        placeholder: { tag: "plain_text", content: "输入自定义回答…" },
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "提交自定义回答" },
        type: "default",
        width: "default",
        size: "medium",
        form_action_type: "submit",
        name: "custom_submit",
        behaviors: [{ type: "callback", value: { t: actionToken, k: "qc", s: step } }],
      },
    ],
  }
}

function header(title: string, template: string): Record<string, unknown> {
  return {
    template,
    title: { tag: "plain_text", content: title },
    padding: "12px 12px 12px 12px",
  }
}

function markdown(content: string): Record<string, unknown> {
  return { tag: "markdown", content, text_align: "left", text_size: "normal_v2" }
}

function wrap(title: string, template: string, elements: Record<string, unknown>[]): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: header(title, template),
    body: { direction: "vertical", padding: "12px 12px 12px 12px", elements },
  }
}

function optionLine(option: QuestionOption, index: number, mark: string, withDescription: boolean): string {
  const head = `${index + 1}. ${mark}**${esc(option.label, 200)}**`
  if (!withDescription || !option.description) return head
  return `${head} — ${esc(option.description, OPTION_TEXT_LIMIT)}`
}

/**
 * The full option text as a markdown list.
 *
 * A Feishu button is `plain_text` and single-line: the client clips anything
 * that does not fit, with no way to wrap. So the authoritative text lives here,
 * in markdown, where it wraps; buttons only carry `<index>. <label>`.
 *
 * Over the budget the list degrades (descriptions first, then whole entries)
 * instead of growing a card that Feishu would reject.
 */
function optionsBlock(
  options: readonly QuestionOption[],
  mark: (option: QuestionOption, index: number) => string,
): string | undefined {
  if (options.length === 0) return undefined
  const lines: string[] = []
  let used = 0
  let degraded = false
  options.forEach((option, index) => {
    if (normalize(option.description ?? "").length > OPTION_TEXT_LIMIT) degraded = true
    const full = optionLine(option, index, mark(option, index), true)
    if (used + full.length <= OPTIONS_BLOCK_LIMIT) {
      lines.push(full)
      used += full.length
      return
    }
    degraded = true
    const short = optionLine(option, index, mark(option, index), false)
    if (used + short.length <= OPTIONS_BLOCK_LIMIT) {
      lines.push(short)
      used += short.length
    }
  })
  if (degraded) lines.push(OPTIONS_TRUNCATED_NOTICE)
  return lines.join("\n")
}

function optionButtonLabel(option: QuestionOption, index: number, mark: string): string {
  return `${mark}${index + 1}. ${plainText(option.label, BUTTON_LABEL_LIMIT)}`
}

function questionTitle(question: QuestionSpec | undefined, index: number): string {
  return question?.header || question?.question || `问题 ${index + 1}`
}

/**
 * Build the interactive decision card. For questions, `progress` selects the
 * wizard step to render; it defaults to the first question.
 */
export function buildDecisionCard(
  request: DecisionRequest,
  actionToken: string,
  progress?: WizardProgress,
): Record<string, unknown> {
  const context = [`**项目**：${esc(request.project, 120)}`, `**会话**：${esc(request.session, 240)}`]
  if (request.childSession) context.push(`**子会话**：${esc(request.childSession, 240)}`)

  if (request.kind === "permission") {
    context.push(`**权限**：${esc(request.permission, 120)}`)
    context.push(`**操作**：${esc(request.patterns.join(" | ") || "未提供", 1_200)}`)
    const elements: Record<string, unknown>[] = [markdown(context.join("\n"))]
    elements.push(button("允许一次 (once)", "primary", { t: actionToken, k: "p", r: "once" }))
    elements.push(button("拒绝 (reject)", "danger", { t: actionToken, k: "p", r: "reject" }))
    return wrap("[OpenCode] 等待权限确认", "orange", elements)
  }

  const questions = request.questions
  const state = progress ?? initialProgress(questions)
  if (isReviewStep(questions, state)) return reviewCard(questions, state, actionToken, context)
  return questionCard(questions, state, actionToken, context)
}

function questionCard(
  questions: readonly QuestionSpec[],
  state: WizardProgress,
  actionToken: string,
  context: string[],
): Record<string, unknown> {
  const total = questions.length
  const step = Math.max(0, Math.min(state.step, total - 1))
  const question = questions[step]
  const text = question?.question || question?.header || "需要你的决策"

  const lines = [...context]
  if (total > 1) {
    const label = question?.header ? `（${esc(question.header, 60)}）` : ""
    lines.push(`**问题 ${step + 1}/${total}${label}**：${esc(text, 1_200)}`)
  } else {
    lines.push(`**问题**：${esc(text, 1_200)}`)
  }
  const current = state.answers[step]
  if (current && current.length > 0) lines.push(`**当前回答**：${esc(current.join("、"), 600)}`)

  const options = question?.options ?? []
  const multiple = question?.multiple === true
  const mark = multiple
    ? (option: QuestionOption) => (state.selected.includes(option.label) ? "☑ " : "☐ ")
    : (option: QuestionOption) => (current?.includes(option.label) ? "✓ " : "")
  const block = optionsBlock(options, mark)
  if (block) {
    lines.push(multiple ? "**选项**（可多选，勾选后点下方确认）：" : "**选项**：")
    lines.push(block)
  }

  const elements: Record<string, unknown>[] = [markdown(lines.join("\n"))]

  if (multiple) {
    options.forEach((option, index) => {
      const checked = state.selected.includes(option.label)
      elements.push(
        button(optionButtonLabel(option, index, checked ? "☑ " : "☐ "), checked ? "primary" : "default", {
          t: actionToken,
          k: "qt",
          s: step,
          c: index,
        }, "fill"),
      )
    })
    const confirm = total > 1 ? "确认本题" : "提交"
    elements.push(button(`${confirm}（已选 ${state.selected.length} 项）`, "primary", { t: actionToken, k: "qn", s: step }))
  } else {
    options.forEach((option, index) => {
      const chosen = current?.includes(option.label) ? "✓ " : ""
      elements.push(
        button(optionButtonLabel(option, index, chosen), "primary", { t: actionToken, k: "q", s: step, c: index }, "fill"),
      )
    })
  }

  if (question?.custom) {
    elements.push(markdown(question.multiple ? "或输入自定义回答（与已勾选项一并提交）：" : "或输入自定义回答："))
    elements.push(customForm(actionToken, step))
  }
  if (step > 0) elements.push(button("上一题", "default", { t: actionToken, k: "qb", s: step }))
  elements.push(button("拒绝 (reject)", "danger", { t: actionToken, k: "qx" }))

  const title = total > 1 ? `[OpenCode] 等待你的决策（${step + 1}/${total}）` : "[OpenCode] 等待你的决策"
  return wrap(title, "blue", elements)
}

function reviewCard(
  questions: readonly QuestionSpec[],
  state: WizardProgress,
  actionToken: string,
  context: string[],
): Record<string, unknown> {
  const total = questions.length
  const lines = [...context, `**请确认以下 ${total} 个回答：**`]
  questions.forEach((question, index) => {
    const answer = state.answers[index]
    const value = answer && answer.length > 0 ? esc(answer.join("、"), 600) : "未回答"
    lines.push(`${index + 1}. **${esc(questionTitle(question, index), 120)}**：${value}`)
  })
  const elements: Record<string, unknown>[] = [markdown(lines.join("\n"))]
  elements.push(button("确认提交", "primary", { t: actionToken, k: "qs", s: total }))
  elements.push(button("上一题", "default", { t: actionToken, k: "qb", s: total }))
  elements.push(button("拒绝 (reject)", "danger", { t: actionToken, k: "qx" }))
  return wrap("[OpenCode] 确认你的决策", "blue", elements)
}

export interface ResolvedCardInput {
  title: string
  template: string
  lines: string[]
}

/** Build a plain (button-less) card used to replace a decision card once it is settled. */
export function buildResolvedCard(input: ResolvedCardInput): Record<string, unknown> {
  return wrap(input.title, input.template, [markdown(input.lines.join("\n"))])
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

export function parseActionValue(raw: unknown): CardActionValue | undefined {
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const t = record.t
  const k = record.k
  if (typeof t !== "string" || typeof k !== "string" || !ACTION_KINDS.has(k)) return undefined
  const out: CardActionValue = { t, k: k as CardActionValue["k"] }
  const step = nonNegativeInt(record.s)
  if (step !== undefined) out.s = step
  const option = nonNegativeInt(record.c)
  if (option !== undefined) out.c = option
  if (record.r === "once" || record.r === "reject") out.r = record.r
  return out
}

/** Read a text field submitted from a card form (raw SDK event or flattened shape). */
export function parseFormText(data: Record<string, unknown>, field: string, limit = 2_000): string | undefined {
  const action = data.action as Record<string, unknown> | undefined
  let form: unknown = action?.form_value ?? data.form_value
  if (typeof form === "string") {
    try {
      form = JSON.parse(form)
    } catch {
      return undefined
    }
  }
  if (typeof form !== "object" || form === null) return undefined
  const value = (form as Record<string, unknown>)[field]
  if (typeof value !== "string") return undefined
  const text = value.trim()
  return text.length > 0 ? text.slice(0, limit) : undefined
}

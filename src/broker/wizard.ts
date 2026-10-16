import type { QuestionSpec } from "../types.js"

/**
 * Step-wise answering of a question request inside a Feishu card.
 *
 * Steps `0..n-1` are the questions. Step `n` is a review step that only exists
 * when there is more than one question. OpenCode accepts every answer in a
 * single reply, so intermediate steps only update this progress; the final
 * submit produces the complete `answers` array (one entry per question).
 */
export interface WizardProgress {
  step: number
  answers: (string[] | null)[]
  /** Working selection of the current multi-select step. */
  selected: string[]
}

export type WizardAction =
  | { kind: "pick"; step: number; option: number }
  | { kind: "toggle"; step: number; option: number }
  | { kind: "confirm"; step: number }
  | { kind: "custom"; step: number; text: string | undefined }
  | { kind: "back"; step: number }
  | { kind: "submit"; step: number }
  | { kind: "reject" }

export type WizardOutcome =
  | { type: "render"; progress: WizardProgress; notice?: string }
  | { type: "submit"; answers: string[][] }
  | { type: "reject" }

export interface WizardActionValue {
  k: string
  s?: number
  c?: number
}

export function initialProgress(questions: readonly QuestionSpec[]): WizardProgress {
  return { step: 0, answers: questions.map(() => null), selected: [] }
}

export function isReviewStep(questions: readonly QuestionSpec[], progress: WizardProgress): boolean {
  return questions.length > 1 && progress.step >= questions.length
}

/** Map a card button value to a wizard action. Cards sent before steps existed carry no `s` (step 0). */
export function toWizardAction(value: WizardActionValue, customText: string | undefined): WizardAction | undefined {
  const step = value.s ?? 0
  if (value.k === "q") return value.c === undefined ? undefined : { kind: "pick", step, option: value.c }
  if (value.k === "qt") return value.c === undefined ? undefined : { kind: "toggle", step, option: value.c }
  if (value.k === "qn") return { kind: "confirm", step }
  if (value.k === "qc") return { kind: "custom", step, text: customText }
  if (value.k === "qb") return { kind: "back", step }
  if (value.k === "qs") return { kind: "submit", step }
  if (value.k === "qx") return { kind: "reject" }
  return undefined
}

export function advance(questions: readonly QuestionSpec[], progress: WizardProgress, action: WizardAction): WizardOutcome {
  if (action.kind === "reject") return { type: "reject" }

  const stay = (notice?: string): WizardOutcome => ({ type: "render", progress, ...(notice ? { notice } : {}) })
  // A click rendered for another step (double tap, stale card) must not change the answers.
  if (action.step !== progress.step) return stay("该操作已过期，已刷新为当前进度")

  if (action.kind === "submit") {
    if (!isReviewStep(questions, progress)) return stay()
    const missing = progress.answers.findIndex((answer) => answer === null)
    if (missing >= 0) return { type: "render", progress: moveTo(questions, progress, missing), notice: "仍有未回答的问题" }
    return { type: "submit", answers: progress.answers.map((answer) => answer ?? []) }
  }

  if (action.kind === "back") {
    if (progress.step === 0) return stay()
    return { type: "render", progress: moveTo(questions, progress, Math.min(progress.step, questions.length) - 1) }
  }

  const question = questions[progress.step]
  if (!question) return stay()

  if (action.kind === "pick") {
    if (question.multiple) return stay("该问题为多选，请勾选后确认")
    const label = question.options[action.option]?.label
    if (!label) return stay("无效的选项")
    return answer(questions, progress, [label])
  }

  if (action.kind === "toggle") {
    if (!question.multiple) return stay()
    const label = question.options[action.option]?.label
    if (!label) return stay("无效的选项")
    const selected = progress.selected.includes(label)
      ? progress.selected.filter((item) => item !== label)
      : [...progress.selected, label]
    return { type: "render", progress: { ...progress, selected } }
  }

  if (action.kind === "confirm") {
    if (!question.multiple) return stay()
    if (progress.selected.length === 0) return stay("请至少选择一项")
    return answer(questions, progress, progress.selected)
  }

  if (!question.custom) return stay("该问题不支持自定义回答")
  const text = action.text?.trim()
  if (!text) return stay("请先输入自定义回答")
  return answer(questions, progress, question.multiple ? unique([...progress.selected, text]) : [text])
}

/** Record the answer of the current step, then move to the next unanswered question or the review step. */
function answer(questions: readonly QuestionSpec[], progress: WizardProgress, values: string[]): WizardOutcome {
  const answers = progress.answers.slice()
  answers[progress.step] = values
  if (questions.length === 1) return { type: "submit", answers: answers.map((item) => item ?? []) }

  const after = answers.findIndex((item, index) => index > progress.step && item === null)
  const next = after >= 0 ? after : answers.findIndex((item) => item === null)
  if (next >= 0) return { type: "render", progress: moveTo(questions, { ...progress, answers }, next) }
  return { type: "render", progress: { step: questions.length, answers, selected: [] } }
}

function moveTo(questions: readonly QuestionSpec[], progress: WizardProgress, step: number): WizardProgress {
  const question = questions[step]
  const previous = progress.answers[step]
  const selected =
    question?.multiple && previous ? previous.filter((label) => question.options.some((option) => option.label === label)) : []
  return { step, answers: progress.answers, selected }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

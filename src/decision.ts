import type { QuestionSpec } from "./types.js"

/**
 * A question request can be answered in a Feishu card when every question has
 * options or accepts a custom answer. Multiple questions are answered step by
 * step and multi-select questions use toggles plus a confirm button; the broker
 * submits all answers at once. Otherwise the user is notified to answer inside
 * OpenCode.
 */
export function isInteractiveQuestion(questions: QuestionSpec[]): boolean {
  if (questions.length === 0) return false
  return questions.every((question) => question.options.length > 0 || question.custom === true)
}

export function optionLabelAt(question: QuestionSpec, index: number): string | undefined {
  return question.options[index]?.label
}

/** OpenCode expects `answers` as one array per question, each holding selected labels. */
export function buildQuestionAnswer(label: string): string[][] {
  return [[label]]
}

export function isAllowedOperator(operatorID: string, allowed: readonly string[]): boolean {
  return allowed.includes(operatorID)
}

export function normalizePermissionReply(value: unknown): "once" | "reject" | undefined {
  return value === "once" || value === "reject" ? value : undefined
}

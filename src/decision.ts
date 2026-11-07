import type { FormAnswer, QuestionSpec } from "./types.js"

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

export type FormAnswerResult = { ok: true; answer: FormAnswer } | { ok: false; notice: string }

/**
 * Convert the wizard's label arrays into the keyed answer map OpenCode 2.x
 * expects. OpenCode's question tool only creates string and multiselect form
 * fields, so a single choice becomes a string and a multi-select becomes an
 * array. Any field that cannot be encoded safely keeps the card open.
 */
export function buildFormAnswer(questions: readonly QuestionSpec[], answers: readonly string[][]): FormAnswerResult {
  const answer: FormAnswer = {}
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]
    const key = question?.key
    if (!question || !key || !question.answerType) {
      return { ok: false, notice: `第 ${index + 1} 题无法在飞书中作答，请回到 OpenCode 处理` }
    }
    const values = answers[index] ?? []
    if (values.length === 0) return { ok: false, notice: `第 ${index + 1} 题还没有回答` }

    if (question.answerType === "multiselect") {
      answer[key] = [...values]
    } else {
      const value = values[0]
      if (value === undefined || value.length === 0) return { ok: false, notice: `第 ${index + 1} 题还没有回答` }
      answer[key] = value
    }
  }
  return { ok: true, answer }
}

export function isAllowedOperator(operatorID: string, allowed: readonly string[]): boolean {
  return allowed.includes(operatorID)
}

export function normalizePermissionReply(value: unknown): "once" | "reject" | undefined {
  return value === "once" || value === "reject" ? value : undefined
}

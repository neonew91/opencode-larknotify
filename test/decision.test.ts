import { describe, expect, test } from "bun:test"
import {
  buildQuestionAnswer,
  isAllowedOperator,
  isInteractiveQuestion,
  normalizePermissionReply,
  optionLabelAt,
} from "../src/decision.js"
import type { QuestionSpec } from "../src/types.js"

const single: QuestionSpec = {
  header: "方案",
  question: "选择实现方案",
  options: [{ label: "A", description: "" }, { label: "B", description: "" }],
  multiple: false,
}

describe("isInteractiveQuestion", () => {
  test("accepts a single single-choice question with options", () => {
    expect(isInteractiveQuestion([single])).toBe(true)
  })

  test("accepts multi-select", () => {
    expect(isInteractiveQuestion([{ ...single, multiple: true }])).toBe(true)
  })

  test("accepts multiple questions", () => {
    expect(isInteractiveQuestion([single, { ...single, multiple: true }, { ...single, options: [], custom: true }])).toBe(true)
  })

  test("rejects an empty question list", () => {
    expect(isInteractiveQuestion([])).toBe(false)
  })

  test("rejects when any question can not be answered", () => {
    expect(isInteractiveQuestion([single, { ...single, options: [], custom: false }])).toBe(false)
  })

  test("rejects a question without options", () => {
    expect(isInteractiveQuestion([{ ...single, options: [] }])).toBe(false)
  })

  test("accepts a custom question without options", () => {
    expect(isInteractiveQuestion([{ ...single, options: [], custom: true }])).toBe(true)
  })
})

describe("helpers", () => {
  test("optionLabelAt returns labels by index", () => {
    expect(optionLabelAt(single, 1)).toBe("B")
    expect(optionLabelAt(single, 9)).toBeUndefined()
  })

  test("buildQuestionAnswer wraps a label into the answers shape", () => {
    expect(buildQuestionAnswer("A")).toEqual([["A"]])
  })

  test("isAllowedOperator checks membership", () => {
    expect(isAllowedOperator("ou_a", ["ou_a", "ou_b"])).toBe(true)
    expect(isAllowedOperator("ou_x", ["ou_a"])).toBe(false)
  })

  test("normalizePermissionReply only allows once and reject", () => {
    expect(normalizePermissionReply("once")).toBe("once")
    expect(normalizePermissionReply("reject")).toBe("reject")
    expect(normalizePermissionReply("always")).toBeUndefined()
    expect(normalizePermissionReply(42)).toBeUndefined()
  })
})

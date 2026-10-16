import { describe, expect, test } from "bun:test"
import { advance, initialProgress, isReviewStep, toWizardAction, type WizardOutcome, type WizardProgress } from "../src/broker/wizard.js"
import type { QuestionSpec } from "../src/types.js"

const single: QuestionSpec = {
  header: "方案",
  question: "选择方案",
  options: [{ label: "A", description: "" }, { label: "B", description: "" }],
  multiple: false,
  custom: true,
}

const multi: QuestionSpec = {
  header: "范围",
  question: "选择模块",
  options: [{ label: "前端", description: "" }, { label: "后端", description: "" }, { label: "测试", description: "" }],
  multiple: true,
  custom: true,
}

const strict: QuestionSpec = { ...single, header: "部署", custom: false }

function rendered(outcome: WizardOutcome): WizardProgress {
  if (outcome.type !== "render") throw new Error(`expected render, got ${outcome.type}`)
  return outcome.progress
}

describe("single question", () => {
  test("a pick submits immediately", () => {
    const outcome = advance([single], initialProgress([single]), { kind: "pick", step: 0, option: 1 })
    expect(outcome).toEqual({ type: "submit", answers: [["B"]] })
  })

  test("a custom answer submits immediately", () => {
    const outcome = advance([single], initialProgress([single]), { kind: "custom", step: 0, text: "  自定义  " })
    expect(outcome).toEqual({ type: "submit", answers: [["自定义"]] })
  })

  test("a multi-select question toggles then submits on confirm", () => {
    let state = initialProgress([multi])
    state = rendered(advance([multi], state, { kind: "toggle", step: 0, option: 0 }))
    state = rendered(advance([multi], state, { kind: "toggle", step: 0, option: 2 }))
    state = rendered(advance([multi], state, { kind: "toggle", step: 0, option: 0 }))
    expect(state.selected).toEqual(["测试"])
    expect(advance([multi], state, { kind: "confirm", step: 0 })).toEqual({ type: "submit", answers: [["测试"]] })
  })
})

describe("multiple questions", () => {
  const questions = [single, multi, strict]

  test("walks every question, reviews, then submits all answers in order", () => {
    let state = initialProgress(questions)
    state = rendered(advance(questions, state, { kind: "pick", step: 0, option: 0 }))
    expect(state.step).toBe(1)

    state = rendered(advance(questions, state, { kind: "toggle", step: 1, option: 1 }))
    state = rendered(advance(questions, state, { kind: "custom", step: 1, text: "运维" }))
    expect(state.step).toBe(2)

    state = rendered(advance(questions, state, { kind: "pick", step: 2, option: 1 }))
    expect(state.step).toBe(3)
    expect(isReviewStep(questions, state)).toBe(true)

    expect(advance(questions, state, { kind: "submit", step: 3 })).toEqual({
      type: "submit",
      answers: [["A"], ["后端", "运维"], ["B"]],
    })
  })

  test("ignores a click rendered for another step", () => {
    let state = initialProgress(questions)
    state = rendered(advance(questions, state, { kind: "pick", step: 0, option: 0 }))
    const outcome = advance(questions, state, { kind: "pick", step: 0, option: 1 })
    expect(outcome.type).toBe("render")
    expect(rendered(outcome)).toEqual(state)
    expect(outcome.type === "render" ? outcome.notice : undefined).toBeDefined()
  })

  test("back restores the previous multi-select answer and returns to review after editing", () => {
    let state = initialProgress(questions)
    state = rendered(advance(questions, state, { kind: "pick", step: 0, option: 0 }))
    state = rendered(advance(questions, state, { kind: "toggle", step: 1, option: 0 }))
    state = rendered(advance(questions, state, { kind: "confirm", step: 1 }))
    state = rendered(advance(questions, state, { kind: "pick", step: 2, option: 0 }))
    expect(state.step).toBe(3)

    state = rendered(advance(questions, state, { kind: "back", step: 3 }))
    state = rendered(advance(questions, state, { kind: "back", step: 2 }))
    expect(state.step).toBe(1)
    expect(state.selected).toEqual(["前端"])

    state = rendered(advance(questions, state, { kind: "toggle", step: 1, option: 2 }))
    state = rendered(advance(questions, state, { kind: "confirm", step: 1 }))
    expect(state.step).toBe(3)
    expect(state.answers).toEqual([["A"], ["前端", "测试"], ["A"]])
  })

  test("validates confirm, custom and submit preconditions", () => {
    let state = initialProgress(questions)
    state = rendered(advance(questions, state, { kind: "pick", step: 0, option: 0 }))

    const emptyConfirm = advance(questions, state, { kind: "confirm", step: 1 })
    expect(rendered(emptyConfirm).step).toBe(1)
    expect(emptyConfirm.type === "render" ? emptyConfirm.notice : undefined).toBe("请至少选择一项")

    const emptyCustom = advance(questions, state, { kind: "custom", step: 1, text: "   " })
    expect(emptyCustom.type === "render" ? emptyCustom.notice : undefined).toBe("请先输入自定义回答")

    const earlySubmit = advance(questions, state, { kind: "submit", step: 1 })
    expect(rendered(earlySubmit).step).toBe(1)

    state = rendered(advance(questions, state, { kind: "toggle", step: 1, option: 0 }))
    state = rendered(advance(questions, state, { kind: "confirm", step: 1 }))
    const notAllowed = advance(questions, state, { kind: "custom", step: 2, text: "x" })
    expect(notAllowed.type === "render" ? notAllowed.notice : undefined).toBe("该问题不支持自定义回答")
  })

  test("reject works from any step", () => {
    let state = initialProgress(questions)
    state = rendered(advance(questions, state, { kind: "pick", step: 0, option: 1 }))
    expect(advance(questions, state, { kind: "reject" })).toEqual({ type: "reject" })
  })
})

describe("toWizardAction", () => {
  test("maps card values and treats a missing step as the first step", () => {
    expect(toWizardAction({ k: "q", c: 1 }, undefined)).toEqual({ kind: "pick", step: 0, option: 1 })
    expect(toWizardAction({ k: "qt", s: 2, c: 0 }, undefined)).toEqual({ kind: "toggle", step: 2, option: 0 })
    expect(toWizardAction({ k: "qn", s: 1 }, undefined)).toEqual({ kind: "confirm", step: 1 })
    expect(toWizardAction({ k: "qc", s: 1 }, "x")).toEqual({ kind: "custom", step: 1, text: "x" })
    expect(toWizardAction({ k: "qb", s: 3 }, undefined)).toEqual({ kind: "back", step: 3 })
    expect(toWizardAction({ k: "qs", s: 3 }, undefined)).toEqual({ kind: "submit", step: 3 })
    expect(toWizardAction({ k: "qx" }, undefined)).toEqual({ kind: "reject" })
  })

  test("rejects incomplete or unknown values", () => {
    expect(toWizardAction({ k: "q" }, undefined)).toBeUndefined()
    expect(toWizardAction({ k: "p" }, undefined)).toBeUndefined()
  })
})

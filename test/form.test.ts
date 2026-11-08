import { describe, expect, test } from "bun:test"
import { buildFormAnswer } from "../src/decision.js"
import type { QuestionSpec } from "../src/types.js"

const questions: QuestionSpec[] = [
  {
    header: "方案",
    question: "选哪个",
    options: [{ label: "A", description: "" }],
    multiple: false,
    custom: true,
    key: "q0",
    answerType: "string",
  },
  {
    header: "范围",
    question: "选择模块",
    options: [{ label: "前端", description: "" }],
    multiple: true,
    custom: true,
    key: "q1",
    answerType: "multiselect",
  },
]

describe("buildFormAnswer", () => {
  test("encodes single choices as strings and multi-select as arrays", () => {
    expect(buildFormAnswer(questions, [["A"], ["前端", "后端"]])).toEqual({
      ok: true,
      answer: { q0: "A", q1: ["前端", "后端"] },
    })
  })

  test("rejects missing answers and unsupported questions", () => {
    expect(buildFormAnswer(questions, [["A"], []])).toMatchObject({ ok: false })
    expect(
      buildFormAnswer([{ header: "h", question: "q", options: [], multiple: false }], [["x"]]),
    ).toMatchObject({ ok: false })
  })
})

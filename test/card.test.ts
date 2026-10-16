import { describe, expect, test } from "bun:test"
import { buildDecisionCard, buildResolvedCard, parseActionValue, parseFormText } from "../src/broker/card.js"
import { advance, initialProgress, type WizardProgress } from "../src/broker/wizard.js"
import type { DecisionRequest, QuestionSpec } from "../src/types.js"

const questionRequest: DecisionRequest = {
  kind: "question",
  requestID: "q-1",
  instanceID: "inst",
  sessionID: "s",
  directory: "/home/user/project",
  project: "~/project",
  session: "Root task",
  questions: [
    { header: "方案", question: "选择实现方案", options: [{ label: "方案A", description: "简单" }, { label: "方案B", description: "完整" }], multiple: false },
  ],
}

const permissionRequest: DecisionRequest = {
  kind: "permission",
  requestID: "p-1",
  instanceID: "inst",
  sessionID: "s",
  directory: "/home/user/project",
  project: "~/project",
  session: "Root task",
  permission: "bash",
  patterns: ["git push origin main"],
}

describe("buildDecisionCard", () => {
  test("renders question options and a reject button with the action token", () => {
    const card = buildDecisionCard(questionRequest, "tok-q")
    const serialized = JSON.stringify(card)
    expect(serialized).toContain("方案A")
    expect(serialized).toContain("tok-q")
    expect(serialized).toContain('"k":"q"')
    expect(serialized).toContain('"k":"qx"')
  })

  test("renders permission once/reject buttons and never always", () => {
    const card = buildDecisionCard(permissionRequest, "tok-p")
    const serialized = JSON.stringify(card)
    expect(serialized).toContain("允许一次")
    expect(serialized).toContain('"r":"once"')
    expect(serialized).toContain('"r":"reject"')
    expect(serialized).not.toContain("always")
  })
})

describe("long option text", () => {
  // Long enough that a single-line Feishu button would clip it, which is the
  // whole reason the full text lives in a markdown list instead.
  const long =
    "这是一段故意写得很长的选项说明，用来验证完整文案会被放进 markdown 清单而不是塞进按钮里，因为飞书按钮是单行文本，超出宽度的部分会被客户端直接裁掉且无法换行"
  const request: DecisionRequest = {
    ...questionRequest,
    questions: [
      {
        header: "方案",
        question: "选择实现方案",
        multiple: false,
        options: [
          { label: "方案 A：保持现有实现", description: long },
          // The ">" exercises markdown escaping: escaped in the list, raw on the button.
          { label: ">=1.0.0 <2.0.0", description: "带尖括号的标签" },
        ],
      },
    ],
  }

  function parts(card: Record<string, unknown>) {
    const elements = (card.body as { elements: Record<string, unknown>[] }).elements
    const text = elements
      .filter((element) => element.tag === "markdown")
      .map((element) => element.content as string)
      .join("\n")
    const buttons = elements
      .filter((element) => element.tag === "button")
      .map((element) => ({
        text: (element.text as { content: string }).content,
        width: element.width as string,
      }))
    return { text, buttons }
  }

  test("keeps the full option text in markdown, never truncated", () => {
    const { text } = parts(buildDecisionCard(request, "tok"))
    expect(text).toContain(long)
    expect(text).toContain("1. **方案 A：保持现有实现** — ")
    expect(text).not.toContain("…")
  })

  test("keeps option buttons short, indexed and full width", () => {
    const { buttons } = parts(buildDecisionCard(request, "tok"))
    const options = buttons.filter((item) => /^\d+\. /.test(item.text))
    expect(options.map((item) => item.text)).toEqual(["1. 方案 A：保持现有实现", "2. >=1.0.0 <2.0.0"])
    expect(options.every((item) => item.width === "fill")).toBe(true)
  })

  test("never markdown-escapes button text", () => {
    const { buttons, text } = parts(buildDecisionCard(request, "tok"))
    expect(buttons.some((item) => item.text.includes("\\"))).toBe(false)
    // the same label inside markdown stays escaped
    expect(text).toContain("\\>=1.0.0")
  })

  test("degrades long option lists instead of growing without bound", () => {
    const filler = "说明".repeat(200) // 400 chars, right at the per-option limit
    const many: QuestionSpec[] = [
      {
        header: "多",
        question: "选一个",
        multiple: false,
        options: Array.from({ length: 20 }, (_, index) => ({ label: `选项${index + 1}`, description: filler })),
      },
    ]
    const { text, buttons } = parts(buildDecisionCard({ ...questionRequest, questions: many }, "tok"))
    expect(text.length).toBeLessThan(8_000)
    expect(text).toContain("已省略部分内容")
    // every option still gets a button and a list entry
    expect(buttons.filter((item) => /^\d+\. /.test(item.text))).toHaveLength(20)
    expect(text).toContain("20. **选项20**")
  })

  test("flags a single over-long description as degraded", () => {
    const over: QuestionSpec[] = [
      {
        header: "单",
        question: "选一个",
        multiple: false,
        options: [{ label: "A", description: "说明".repeat(300) }],
      },
    ]
    const { text } = parts(buildDecisionCard({ ...questionRequest, questions: over }, "tok"))
    expect(text).toContain("已省略部分内容")
  })
})

describe("parseActionValue", () => {
  test("parses a JSON string payload", () => {
    expect(parseActionValue(JSON.stringify({ t: "tok", k: "q", c: 0 }))).toEqual({ t: "tok", k: "q", c: 0 })
  })

  test("parses an object payload", () => {
    expect(parseActionValue({ t: "tok", k: "p", r: "once" })).toEqual({ t: "tok", k: "p", r: "once" })
  })

  test("rejects malformed payloads", () => {
    expect(parseActionValue("not json")).toBeUndefined()
    expect(parseActionValue({ k: "q" })).toBeUndefined()
    expect(parseActionValue({ t: "tok", k: "bad" })).toBeUndefined()
  })
})

describe("buildResolvedCard", () => {
  test("builds a button-less card", () => {
    const card = buildResolvedCard({ title: "[OpenCode] 已处理", template: "grey", lines: ["你的选择：方案A"] })
    const serialized = JSON.stringify(card)
    expect(serialized).toContain("已处理")
    expect(serialized).toContain("方案A")
    expect(serialized).not.toContain('"tag":"button"')
  })
})

describe("custom answer", () => {
  const customRequest: DecisionRequest = {
    kind: "question",
    requestID: "q-2",
    instanceID: "inst",
    sessionID: "s",
    directory: "/home/user/project",
    project: "~/project",
    session: "Root task",
    questions: [
      { header: "方案", question: "选择实现方案", options: [{ label: "方案A", description: "" }], multiple: false, custom: true },
    ],
  }

  test("renders an input form with a qc submit and keeps reject", () => {
    const serialized = JSON.stringify(buildDecisionCard(customRequest, "tok-c"))
    expect(serialized).toContain('"tag":"form"')
    expect(serialized).toContain('"tag":"input"')
    expect(serialized).toContain('"form_action_type":"submit"')
    expect(serialized).toContain('"k":"qc"')
    expect(serialized).toContain('"k":"qx"')
  })

  test("does not render a form when custom is not allowed", () => {
    expect(JSON.stringify(buildDecisionCard(questionRequest, "tok-q"))).not.toContain('"tag":"form"')
  })

  test("parseActionValue accepts the custom submit kind", () => {
    expect(parseActionValue({ t: "tok", k: "qc" })).toEqual({ t: "tok", k: "qc" })
  })

  test("parseFormText reads object and string form values", () => {
    expect(parseFormText({ action: { form_value: { answer: "  自定义方案  " } } }, "answer")).toBe("自定义方案")
    expect(parseFormText({ form_value: JSON.stringify({ answer: "方案X" }) }, "answer")).toBe("方案X")
  })

  test("parseFormText rejects empty or missing values", () => {
    expect(parseFormText({ action: { form_value: { answer: "   " } } }, "answer")).toBeUndefined()
    expect(parseFormText({ action: {} }, "answer")).toBeUndefined()
    expect(parseFormText({ form_value: "not json" }, "answer")).toBeUndefined()
  })
})

describe("multi-question wizard card", () => {
  const questions: QuestionSpec[] = [
    { header: "方案", question: "选择方案", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiple: false },
    { header: "范围", question: "选择模块", options: [{ label: "前端", description: "" }, { label: "后端", description: "" }], multiple: true, custom: true },
  ]
  const request: DecisionRequest = { ...questionRequest, questions }

  function step(state: WizardProgress, action: Parameters<typeof advance>[2]): WizardProgress {
    const outcome = advance(questions, state, action)
    if (outcome.type !== "render") throw new Error("expected render")
    return outcome.progress
  }

  test("renders the first step with progress and without a back button", () => {
    const serialized = JSON.stringify(buildDecisionCard(request, "tok", initialProgress(questions)))
    expect(serialized).toContain("（1/2）")
    expect(serialized).toContain('"k":"q","s":0')
    expect(serialized).not.toContain('"k":"qb"')
    expect(serialized).toContain('"k":"qx"')
  })

  test("renders a multi-select step with toggles, confirm, custom form and back", () => {
    const state = step(initialProgress(questions), { kind: "pick", step: 0, option: 0 })
    const toggled = step(state, { kind: "toggle", step: 1, option: 1 })
    const serialized = JSON.stringify(buildDecisionCard(request, "tok", toggled))
    expect(serialized).toContain("（2/2）")
    expect(serialized).toContain('"k":"qt","s":1')
    expect(serialized).toContain("2. ☑ **后端**")
    expect(serialized).toContain("1. ☐ **前端**")
    expect(serialized).toContain("☑ 2. 后端")
    expect(serialized).toContain("☐ 1. 前端")
    expect(serialized).toContain("确认本题（已选 1 项）")
    expect(serialized).toContain('"k":"qn","s":1')
    expect(serialized).toContain('"k":"qc","s":1')
    expect(serialized).toContain('"k":"qb","s":1')
  })

  test("renders the review step with every answer and a submit button", () => {
    let state = step(initialProgress(questions), { kind: "pick", step: 0, option: 1 })
    state = step(state, { kind: "toggle", step: 1, option: 0 })
    state = step(state, { kind: "confirm", step: 1 })
    const serialized = JSON.stringify(buildDecisionCard(request, "tok", state))
    expect(serialized).toContain("[OpenCode] 确认你的决策")
    expect(serialized).toContain("B")
    expect(serialized).toContain("前端")
    expect(serialized).toContain('"k":"qs","s":2')
    expect(serialized).toContain('"k":"qb","s":2')
  })

  test("keeps the single-question card unchanged", () => {
    const serialized = JSON.stringify(buildDecisionCard(questionRequest, "tok"))
    expect(serialized).toContain('"content":"[OpenCode] 等待你的决策"')
    expect(serialized).not.toContain("1/1")
    expect(serialized).not.toContain('"k":"qb"')
  })

  test("parseActionValue keeps the step and drops invalid numbers", () => {
    expect(parseActionValue({ t: "tok", k: "qt", s: 1, c: 2 })).toEqual({ t: "tok", k: "qt", s: 1, c: 2 })
    expect(parseActionValue({ t: "tok", k: "qs", s: 3 })).toEqual({ t: "tok", k: "qs", s: 3 })
    expect(parseActionValue({ t: "tok", k: "q", s: -1, c: 1.5 })).toEqual({ t: "tok", k: "q" })
  })
})

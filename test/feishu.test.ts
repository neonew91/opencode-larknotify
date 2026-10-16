import { describe, expect, test } from "bun:test"
import { createFeishuPayload, createSignature, sendFeishu } from "../src/feishu.js"
import type { IdleNotification } from "../src/types.js"

const notification: IdleNotification = {
  kind: "idle",
  project: "op-notifier",
  session: "Implement notifications",
  durationMs: 125_000,
  summary: { files: 3, additions: 20, deletions: 4 },
}

describe("Feishu payload", () => {
  test("generates the documented signature", () => {
    expect(createSignature("1599360473", "demo")).toBe("l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=")
  })

  test("creates a concise interactive card", () => {
    const payload = createFeishuPayload(notification, "ou_example")
    const serialized = JSON.stringify(payload)

    expect(payload.msg_type).toBe("interactive")
    expect(serialized).toContain("[OpenCode] 任务已结束")
    expect(serialized).toContain("2 分 5 秒")
    expect(serialized).toContain("<at id=ou_example></at>")
  })

  test("lists every question of a multi-question notification", () => {
    const serialized = JSON.stringify(
      createFeishuPayload({
        kind: "question",
        project: "op-notifier",
        session: "Plan",
        questions: [
          { header: "方案", question: "选择实现方案", options: ["A", "B"] },
          { header: "范围", question: "需要覆盖哪些模块", options: ["前端"] },
        ],
      }),
    )
    expect(serialized).toContain("问题 1/2")
    expect(serialized).toContain("问题 2/2")
    expect(serialized).toContain("需要覆盖哪些模块")
  })
})

describe("sendFeishu", () => {
  test("signs and sends a webhook request", async () => {
    let requestBody: Record<string, unknown> | undefined
    const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({ code: 0, msg: "success" })
    }

    await sendFeishu(
      notification,
      {
        webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/example",
        secret: "demo",
      },
      { fetch: fetcher, now: () => 1_599_360_473_000 },
    )

    expect(requestBody?.timestamp).toBe("1599360473")
    expect(requestBody?.sign).toBe("l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=")
  })

  test("retries transient failures", async () => {
    let attempts = 0
    const delays: number[] = []
    const fetcher = async (): Promise<Response> => {
      attempts++
      if (attempts < 3) return new Response("unavailable", { status: 503 })
      return Response.json({ code: 0 })
    }

    await sendFeishu(
      notification,
      { webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/example" },
      {
        fetch: fetcher,
        sleep: async (durationMs) => {
          delays.push(durationMs)
        },
      },
    )

    expect(attempts).toBe(3)
    expect(delays).toEqual([250, 500])
  })

  test("does not retry a rejected message", async () => {
    let attempts = 0
    const fetcher = async (): Promise<Response> => {
      attempts++
      return Response.json({ code: 19021, msg: "sign match fail" })
    }

    await expect(
      sendFeishu(notification, { webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/example" }, { fetch: fetcher }),
    ).rejects.toThrow("19021")
    expect(attempts).toBe(1)
  })
})

describe("legacy question notification", () => {
  test("renders the single-question shape sent by plugins before protocol 2", () => {
    const legacy = { kind: "question", project: "p", session: "s", header: "方案", question: "选择方案", options: ["A"] }
    const serialized = JSON.stringify(createFeishuPayload(legacy as never))
    expect(serialized).toContain("选择方案")
    expect(serialized).not.toContain("问题 1/1")
  })
})

describe("question option descriptions", () => {
  function body(notification: Parameters<typeof createFeishuPayload>[0]): string {
    const payload = createFeishuPayload(notification) as { card: { body: { elements: { content: string }[] } } }
    return payload.card.body.elements.map((element) => element.content).join("\n")
  }

  test("renders optionDetails when the plugin provides them", () => {
    const text = body({
      kind: "question",
      project: "~/p",
      session: "s",
      questions: [
        {
          header: "包名",
          question: "用哪个包名？",
          options: ["保持原名", "改名"],
          optionDetails: ["保持原名 — 已经可用，但名不太达意", "改名 — 突出远程开关和决策能力"],
        },
      ],
    })
    expect(text).toContain("已经可用，但名不太达意")
    expect(text).toContain("突出远程开关和决策能力")
  })

  test("falls back to labels when optionDetails is absent (older plugin)", () => {
    const text = body({
      kind: "question",
      project: "~/p",
      session: "s",
      questions: [{ header: "h", question: "q", options: ["A", "B"] }],
    })
    expect(text).toContain("1. A")
    expect(text).toContain("2. B")
  })
})

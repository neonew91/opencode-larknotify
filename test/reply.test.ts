import { describe, expect, test } from "bun:test"
import { rejectQuestion, replyPermission, replyQuestion } from "../src/opencode/reply.js"

function mockClient() {
  const calls: Array<{ url: string; query?: Record<string, unknown>; body?: unknown }> = []
  const client = {
    _client: {
      post: async (opts: { url: string; query?: Record<string, unknown>; body?: unknown }) => {
        calls.push(opts)
        return { response: { ok: true, status: 200 } }
      },
    },
  }
  return { client, calls }
}

describe("opencode reply", () => {
  test("replyQuestion posts answers to the question reply endpoint via the client", async () => {
    const { client, calls } = mockClient()
    await replyQuestion({ client, directory: "/d" }, "q 1", [["方案A"]])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("/question/q%201/reply")
    expect(calls[0]?.body).toEqual({ answers: [["方案A"]] })
    expect(calls[0]?.query).toEqual({ directory: "/d" })
  })

  test("rejectQuestion posts to the reject endpoint without a body", async () => {
    const { client, calls } = mockClient()
    await rejectQuestion({ client, directory: "/d" }, "q1")
    expect(calls[0]?.url).toBe("/question/q1/reject")
    expect(calls[0]?.body).toBeUndefined()
  })

  test("replyPermission posts the reply value", async () => {
    const { client, calls } = mockClient()
    await replyPermission({ client, directory: "/d" }, "p1", "once")
    expect(calls[0]?.url).toBe("/permission/p1/reply")
    expect(calls[0]?.body).toEqual({ reply: "once" })
  })

  test("throws when the API returns an error", async () => {
    const client = { _client: { post: async () => ({ error: { message: "boom" } }) } }
    await expect(replyQuestion({ client, directory: "" }, "q1", [["A"]])).rejects.toThrow()
  })

  test("throws when the client has no low-level post", async () => {
    await expect(replyQuestion({ client: {}, directory: "" }, "q1", [["A"]])).rejects.toThrow()
  })
})

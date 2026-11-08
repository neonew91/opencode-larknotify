import { describe, expect, test } from "bun:test"
import { normalizeEvent, resolvedRequestID } from "../src/opencode/events.js"

describe("normalizeEvent", () => {
  test("keeps OpenCode 1.x permission events usable", () => {
    const event = normalizeEvent({
      type: "permission.asked",
      properties: { id: "p1", sessionID: "s1", permission: "bash", patterns: ["git push"] },
    })
    expect(event).toEqual({
      type: "permission.asked",
      properties: { id: "p1", sessionID: "s1", permission: "bash", patterns: ["git push"] },
    })
  })

  test("maps OpenCode 2 permission actions and resources", () => {
    const event = normalizeEvent({
      type: "permission.asked",
      data: { id: "p1", sessionID: "s1", action: "shell", resources: ["git push"] },
    })
    expect(event?.properties).toMatchObject({ permission: "shell", patterns: ["git push"] })
  })

  test("maps the legacy permission.updated/replied shape", () => {
    const asked = normalizeEvent({
      type: "permission.updated",
      properties: { id: "p1", sessionID: "s1", type: "bash", pattern: ["git push"] },
    })
    expect(asked).toMatchObject({ type: "permission.asked", properties: { permission: "bash", patterns: ["git push"] } })

    const replied = normalizeEvent({
      type: "permission.replied",
      properties: { sessionID: "s1", permissionID: "p1", response: "once" },
    })
    expect(resolvedRequestID(replied!)).toBe("p1")
  })

  test("maps session.idle to a status event and retry stays busy-compatible", () => {
    expect(normalizeEvent({ type: "session.idle", data: { sessionID: "s1" } })?.properties).toEqual({
      sessionID: "s1",
      status: { type: "idle" },
    })
    expect(
      normalizeEvent({ type: "session.status", data: { sessionID: "s1", status: { type: "retry" } } })?.properties,
    ).toEqual({ sessionID: "s1", status: { type: "retry" } })
  })

  test("maps the OpenCode 2 execution lifecycle to busy/idle", () => {
    expect(
      normalizeEvent({ type: "session.execution.started", data: { sessionID: "s1" } })?.properties,
    ).toEqual({ sessionID: "s1", status: { type: "busy" } })
    for (const type of ["session.execution.succeeded", "session.execution.failed"]) {
      expect(normalizeEvent({ type, data: { sessionID: "s1" } })?.properties).toEqual({
        sessionID: "s1",
        status: { type: "idle" },
        terminal: true,
      })
    }
    expect(
      normalizeEvent({ type: "session.execution.interrupted", data: { sessionID: "s1", reason: "user" } })
        ?.properties,
    ).toEqual({ sessionID: "s1", status: { type: "idle" }, terminal: true })
    expect(
      normalizeEvent({ type: "session.execution.interrupted", data: { sessionID: "s1", reason: "shutdown" } }),
    ).toBeUndefined()
  })

  test("translates a question form into a question event", () => {
    const event = normalizeEvent({
      type: "form.created",
      data: {
        form: {
          id: "form-1",
          sessionID: "s1",
          title: "Questions",
          metadata: { kind: "question" },
          fields: [
            {
              key: "q0",
              title: "方案",
              description: "选哪个",
              type: "string",
              custom: true,
              options: [{ value: "A", label: "A", description: "简单" }],
            },
            {
              key: "q1",
              title: "范围",
              description: "选择模块",
              type: "multiselect",
              custom: true,
              options: [{ value: "前端", label: "前端", description: "" }],
            },
          ],
        },
      },
    })
    expect(event?.type).toBe("question.asked")
    expect(event?.properties).toMatchObject({ id: "form-1", sessionID: "s1", form: true })
    expect((event?.properties as { questions: unknown[] }).questions).toEqual([
      {
        header: "方案",
        question: "选哪个",
        options: [{ label: "A", description: "简单" }],
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
    ])
  })

  test("leaves non-question forms and malformed forms alone", () => {
    expect(
      normalizeEvent({
        type: "form.created",
        data: { form: { id: "f", sessionID: "s", metadata: { kind: "mcp-elicitation" }, fields: [] } },
      }),
    ).toBeUndefined()
    expect(normalizeEvent({ type: "form.created", data: {} })).toBeUndefined()
  })

  test("maps form replies and cancellations to request resolutions", () => {
    const replied = normalizeEvent({ type: "form.replied", data: { id: "form-1", sessionID: "s1", answer: {} } })
    const cancelled = normalizeEvent({ type: "form.cancelled", data: { id: "form-2", sessionID: "s1" } })
    expect(resolvedRequestID(replied!)).toBe("form-1")
    expect(resolvedRequestID(cancelled!)).toBe("form-2")
  })

  test("accepts .v2. aliases", () => {
    expect(
      normalizeEvent({
        type: "permission.v2.asked",
        data: { id: "p", sessionID: "s", action: "edit", resources: ["*"] },
      })?.type,
    ).toBe("permission.asked")
  })
})

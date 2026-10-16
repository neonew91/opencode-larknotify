import { describe, expect, test } from "bun:test"
import { createNotifier, formatDirectory, type NotifierMode, type OpenCodeEvent, type SessionInfo } from "../src/notifier.js"
import type { DecisionRequest, Notification } from "../src/types.js"
import type { NotifierBehavior } from "../src/options.js"

const root: SessionInfo = {
  id: "root",
  title: "Root task",
  directory: "/home/user/projects/demo",
  summary: { files: 2, additions: 8, deletions: 1 },
}

const child: SessionInfo = {
  id: "child",
  title: "Explore code",
  directory: "/home/user/projects/demo",
  parentID: "root",
}

const DEFAULT_BEHAVIOR: NotifierBehavior = {
  notifyOnIdle: true,
  notifyOnPermission: true,
  notifyOnQuestion: true,
  minimumDurationMs: 0,
  permissionRemote: true,
}

function fixture(mode: NotifierMode = "notify", behavior: Partial<NotifierBehavior> = {}, options: { remote?: boolean } = {}) {
  let time = 1_000
  let remote = options.remote ?? true
  const notifications: Notification[] = []
  const decisions: DecisionRequest[] = []
  const sessions = new Map<string, SessionInfo>([
    [root.id, { ...root }],
    [child.id, { ...child }],
  ])
  const notifier = createNotifier({
    mode,
    instanceID: "inst-1",
    homeDirectory: "/home/user",
    behavior: { ...DEFAULT_BEHAVIOR, ...behavior },
    loadSession: async (sessionID) => {
      const session = sessions.get(sessionID)
      if (!session) throw new Error("missing session")
      return session
    },
    notify: (notification) => notifications.push(notification),
    decide: (request) => decisions.push(request),
    ...(options.remote !== undefined ? { isRemoteEnabled: () => remote } : {}),
    now: () => time,
  })

  return {
    notifications,
    decisions,
    advance: (durationMs: number) => {
      time += durationMs
    },
    renameRoot: (title: string) => sessions.set(root.id, { ...root, title }),
    handle: (event: OpenCodeEvent) => notifier.handle(event),
    setRemote: (enabled: boolean) => {
      remote = enabled
    },
    flush: () => notifier.flushDeferred(),
    deferredCount: () => notifier.deferredCount(),
  }
}

const status = (sessionID: string, type: "busy" | "idle"): OpenCodeEvent => ({
  type: "session.status",
  properties: { sessionID, status: { type } },
})

describe("formatDirectory", () => {
  test("rewrites the home directory to a tilde", () => {
    expect(formatDirectory("/home/user/projects/demo", "/home/user")).toBe("~/projects/demo")
    expect(formatDirectory("/workspace/project", "/home/user")).toBe("/workspace/project")
  })
})

describe("notify mode", () => {
  test("notifies exactly once for a root busy-to-idle transition", async () => {
    const t = fixture("notify")
    await t.handle(status("root", "idle"))
    await t.handle(status("root", "busy"))
    t.advance(12_000)
    t.renameRoot("实现飞书通知插件")
    await t.handle(status("root", "idle"))
    await t.handle(status("root", "idle"))

    expect(t.notifications).toEqual([
      {
        kind: "idle",
        project: "~/projects/demo",
        session: "实现飞书通知插件",
        durationMs: 12_000,
        summary: { files: 2, additions: 8, deletions: 1 },
      },
    ])
  })

  test("does not notify when only a child session becomes idle", async () => {
    const t = fixture("notify")
    await t.handle(status("child", "busy"))
    t.advance(2_000)
    await t.handle(status("child", "idle"))
    expect(t.notifications).toEqual([])
  })

  test("notifies a child permission once and blocks idle until replied", async () => {
    const t = fixture("notify")
    const asked: OpenCodeEvent = {
      type: "permission.asked",
      properties: { id: "perm-1", sessionID: "child", permission: "bash", patterns: ["git push origin main"] },
    }

    await t.handle(status("root", "busy"))
    await t.handle(asked)
    await t.handle(asked)
    t.advance(3_000)
    await t.handle(status("root", "idle"))

    expect(t.decisions).toEqual([])
    expect(t.notifications).toHaveLength(1)
    expect(t.notifications[0]).toEqual({
      kind: "permission",
      project: "~/projects/demo",
      session: "Root task",
      childSession: "Explore code",
      permission: "bash",
      patterns: ["git push origin main"],
    })

    await t.handle({
      type: "permission.replied",
      properties: { sessionID: "child", requestID: "perm-1", reply: "once" },
    })
    await t.handle(status("root", "idle"))
    expect(t.notifications).toHaveLength(2)
    expect(t.notifications[1]?.kind).toBe("idle")
  })

  test("notifies questions as plain text", async () => {
    const t = fixture("notify")
    await t.handle({
      type: "question.asked",
      properties: {
        id: "q-1",
        sessionID: "root",
        questions: [
          { header: "方案", question: "选择实现方案", options: [{ label: "A", description: "简单" }, { label: "B", description: "完整" }] },
          { header: "范围", question: "需要覆盖哪些模块", multiple: true, options: [{ label: "前端", description: "" }] },
        ],
      },
    })
    expect(t.decisions).toEqual([])
    expect(t.notifications[0]).toEqual({
      kind: "question",
      project: "~/projects/demo",
      session: "Root task",
      questions: [
        {
          header: "方案",
          question: "选择实现方案",
          options: ["A", "B"],
          optionDetails: ["A — 简单", "B — 完整"],
        },
        { header: "范围", question: "需要覆盖哪些模块", options: ["前端"] },
      ],
    })
  })

  test("omits optionDetails when no option has a description", async () => {
    const t = fixture("notify")
    await t.handle({
      type: "question.asked",
      properties: {
        id: "q-nd",
        sessionID: "root",
        questions: [{ header: "h", question: "q", options: [{ label: "A", description: "" }] }],
      },
    })
    const notification = t.notifications[0]
    if (notification?.kind !== "question") throw new Error("expected a question notification")
    expect(notification.questions[0]).toEqual({ header: "h", question: "q", options: ["A"] })
    expect("optionDetails" in (notification.questions[0] as object)).toBe(false)
  })

  test("respects the minimum duration", async () => {
    const t = fixture("notify", { minimumDurationMs: 5_000 })
    await t.handle(status("root", "busy"))
    t.advance(4_999)
    await t.handle(status("root", "idle"))
    expect(t.notifications).toEqual([])
  })
})

describe("interactive mode", () => {
  test("routes a single-choice question to a decision and blocks idle", async () => {
    const t = fixture("interactive")
    await t.handle(status("root", "busy"))
    await t.handle({
      type: "question.asked",
      properties: {
        id: "q-9",
        sessionID: "child",
        questions: [{ header: "方案", question: "选哪个", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }],
      },
    })

    expect(t.notifications).toEqual([])
    expect(t.decisions).toHaveLength(1)
    expect(t.decisions[0]).toMatchObject({
      kind: "question",
      requestID: "q-9",
      instanceID: "inst-1",
      sessionID: "child",
      childSession: "Explore code",
      session: "Root task",
    })

    t.advance(1_000)
    await t.handle(status("root", "idle"))
    expect(t.notifications).toEqual([])

    await t.handle({ type: "question.replied", properties: { sessionID: "child", requestID: "q-9", answers: [["A"]] } })
    await t.handle(status("root", "idle"))
    expect(t.notifications).toHaveLength(1)
    expect(t.notifications[0]?.kind).toBe("idle")
  })

  test("routes permission to a decision when permissionRemote is enabled", async () => {
    const t = fixture("interactive")
    await t.handle({
      type: "permission.asked",
      properties: { id: "p-9", sessionID: "root", permission: "bash", patterns: ["rm -rf build"] },
    })
    expect(t.decisions[0]).toMatchObject({ kind: "permission", requestID: "p-9", permission: "bash" })
  })

  test("notifies permission instead of deciding when permissionRemote is disabled", async () => {
    const t = fixture("interactive", { permissionRemote: false })
    await t.handle({
      type: "permission.asked",
      properties: { id: "p-10", sessionID: "root", permission: "bash", patterns: ["ls"] },
    })
    expect(t.decisions).toEqual([])
    expect(t.notifications[0]?.kind).toBe("permission")
  })

  test("routes multiple questions, including multi-select, to one decision", async () => {
    const t = fixture("interactive")
    await t.handle({
      type: "question.asked",
      properties: {
        id: "q-many",
        sessionID: "root",
        questions: [
          { header: "方案", question: "选择方案", options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
          { header: "范围", question: "选择模块", multiple: true, options: [{ label: "前端", description: "" }, { label: "后端", description: "" }] },
        ],
      },
    })
    expect(t.notifications).toEqual([])
    expect(t.decisions).toHaveLength(1)
    const decision = t.decisions[0]
    expect(decision?.kind).toBe("question")
    if (decision?.kind !== "question") throw new Error("expected a question decision")
    expect(decision.questions.map((question) => question.header)).toEqual(["方案", "范围"])
    expect(decision.questions[1]?.multiple).toBe(true)
  })

  test("falls back to notification when a question can not be answered in a card", async () => {
    const t = fixture("interactive")
    await t.handle({
      type: "question.asked",
      properties: {
        id: "q-open",
        sessionID: "root",
        questions: [{ header: "说明", question: "请描述需求", custom: false, options: [] }],
      },
    })
    expect(t.decisions).toEqual([])
    expect(t.notifications[0]?.kind).toBe("question")
  })

  test("treats question custom as enabled unless explicitly disabled", async () => {
    const t = fixture("interactive")
    const options = [{ label: "A", description: "" }]
    await t.handle({
      type: "question.asked",
      properties: { id: "q-c1", sessionID: "root", questions: [{ header: "h", question: "q", options }] },
    })
    await t.handle({
      type: "question.asked",
      properties: { id: "q-c2", sessionID: "root", questions: [{ header: "h", question: "q", custom: false, options }] },
    })
    const [first, second] = t.decisions
    expect(first?.kind === "question" ? first.questions[0]?.custom : undefined).toBe(true)
    expect(second?.kind === "question" ? second.questions[0]?.custom : undefined).toBe(false)
  })
})

const permissionAsked = (id: string, sessionID = "root"): OpenCodeEvent => ({
  type: "permission.asked",
  properties: { id, sessionID, permission: "bash", patterns: [`echo ${id}`] },
})

const questionAsked = (id: string, sessionID = "root"): OpenCodeEvent => ({
  type: "question.asked",
  properties: {
    id,
    sessionID,
    questions: [{ header: "方案", question: `选哪个 ${id}`, options: [{ label: "A", description: "" }] }],
  },
})

describe("remote switch", () => {
  test("keeps requests in OpenCode while the switch is off", async () => {
    const t = fixture("interactive", {}, { remote: false })
    await t.handle(status("root", "busy"))
    await t.handle(permissionAsked("p-1"))
    await t.handle(questionAsked("q-1", "child"))

    expect(t.decisions).toEqual([])
    expect(t.notifications).toEqual([])
    expect(t.deferredCount()).toBe(2)
  })

  test("pushes waiting requests in arrival order once the switch turns on", async () => {
    const t = fixture("interactive", {}, { remote: false })
    await t.handle(permissionAsked("p-1"))
    await t.handle(questionAsked("q-1", "child"))

    expect(t.flush()).toBe(0)
    expect(t.decisions).toEqual([])

    t.setRemote(true)
    expect(t.flush()).toBe(2)
    expect(t.decisions.map((request) => request.requestID)).toEqual(["p-1", "q-1"])
    expect(t.decisions[1]).toMatchObject({ kind: "question", childSession: "Explore code", session: "Root task" })

    expect(t.flush()).toBe(0)
    expect(t.decisions).toHaveLength(2)
  })

  test("drops requests answered in OpenCode before the switch turns on", async () => {
    const t = fixture("interactive", {}, { remote: false })
    await t.handle(permissionAsked("p-1"))
    await t.handle(questionAsked("q-1"))
    await t.handle(questionAsked("q-2"))
    await t.handle({ type: "permission.replied", properties: { sessionID: "root", requestID: "p-1", reply: "once" } })
    await t.handle({ type: "question.rejected", properties: { sessionID: "root", requestID: "q-1" } })

    t.setRemote(true)
    expect(t.flush()).toBe(1)
    expect(t.decisions.map((request) => request.requestID)).toEqual(["q-2"])
  })

  test("pushes immediately while on and never twice", async () => {
    const t = fixture("interactive", {}, { remote: true })
    await t.handle(permissionAsked("p-1"))
    expect(t.decisions.map((request) => request.requestID)).toEqual(["p-1"])

    t.setRemote(false)
    await t.handle(permissionAsked("p-1"))
    t.setRemote(true)
    expect(t.flush()).toBe(0)
    expect(t.decisions).toHaveLength(1)
  })

  test("drops the idle notification while off instead of sending it later", async () => {
    const t = fixture("interactive", {}, { remote: false })
    await t.handle(status("root", "busy"))
    t.advance(5_000)
    await t.handle(status("root", "idle"))
    expect(t.notifications).toEqual([])

    t.setRemote(true)
    expect(t.flush()).toBe(0)
    expect(t.notifications).toEqual([])

    await t.handle(status("root", "busy"))
    t.advance(1_000)
    await t.handle(status("root", "idle"))
    expect(t.notifications.map((notification) => notification.kind)).toEqual(["idle"])
  })

  test("still blocks the idle notification while a deferred request is pending", async () => {
    const t = fixture("interactive", {}, { remote: false })
    await t.handle(status("root", "busy"))
    await t.handle(permissionAsked("p-1"))
    t.setRemote(true)
    await t.handle(status("root", "idle"))
    expect(t.notifications).toEqual([])

    t.flush()
    await t.handle({ type: "permission.replied", properties: { sessionID: "root", requestID: "p-1", reply: "once" } })
    await t.handle(status("root", "idle"))
    expect(t.notifications.map((notification) => notification.kind)).toEqual(["idle"])
  })

  test("defers plain notifications in notify mode", async () => {
    const t = fixture("notify", {}, { remote: false })
    await t.handle(permissionAsked("p-1"))
    await t.handle(questionAsked("q-1"))
    expect(t.notifications).toEqual([])

    t.setRemote(true)
    expect(t.flush()).toBe(2)
    expect(t.notifications.map((notification) => notification.kind)).toEqual(["permission", "question"])
    expect(t.decisions).toEqual([])
  })

  test("does not defer requests that would not be pushed at all", async () => {
    const t = fixture("notify", { notifyOnPermission: false }, { remote: false })
    await t.handle(permissionAsked("p-1"))
    expect(t.deferredCount()).toBe(0)
  })
})

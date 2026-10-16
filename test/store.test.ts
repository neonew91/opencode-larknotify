import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { RouteStore } from "../src/broker/store.js"
import type { DecisionRequest } from "../src/types.js"

function request(requestID: string): DecisionRequest {
  return {
    kind: "question",
    requestID,
    instanceID: "inst",
    sessionID: "s",
    directory: "/d",
    project: "p",
    session: "root",
    questions: [{ header: "h", question: "q", options: [{ label: "A", description: "" }], multiple: false }],
  }
}

function newStore(): RouteStore {
  return new RouteStore(new Database(":memory:"))
}

describe("RouteStore", () => {
  test("creates and reads a pending action", () => {
    const store = newStore()
    store.create({ actionToken: "t1", connectionID: "c1", request: request("r1"), allowedOpenIds: ["ou"], createdAt: 1_000, expiresAt: 2_000 })
    const record = store.get("t1")
    expect(record?.status).toBe("pending")
    expect(record?.requestID).toBe("r1")
    expect(record?.allowedOpenIds).toEqual(["ou"])
    expect(store.activeCount()).toBe(1)
  })

  test("claim moves pending to processing exactly once", () => {
    const store = newStore()
    store.create({ actionToken: "t1", connectionID: "c1", request: request("r1"), allowedOpenIds: ["ou"], createdAt: 1_000, expiresAt: 5_000 })

    const first = store.claim("t1", "ou", 1_500)
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.row.status).toBe("processing")

    const second = store.claim("t1", "ou", 1_600)
    expect(second).toMatchObject({ ok: false, reason: "already" })
  })

  test("claim fails when expired", () => {
    const store = newStore()
    store.create({ actionToken: "t2", connectionID: "c1", request: request("r2"), allowedOpenIds: ["ou"], createdAt: 1_000, expiresAt: 1_200 })
    const result = store.claim("t2", "ou", 2_000)
    expect(result).toMatchObject({ ok: false, reason: "expired" })
    expect(store.get("t2")?.status).toBe("expired")
  })

  test("claim fails for an unknown token", () => {
    const store = newStore()
    expect(store.claim("missing", "ou", 1)).toMatchObject({ ok: false, reason: "notfound" })
  })

  test("resolveLocally retracts an action that is still waiting for input", () => {
    const store = newStore()
    store.create({ actionToken: "t3", connectionID: "c1", request: request("r3"), allowedOpenIds: ["ou"], createdAt: 1_000, expiresAt: 5_000 })
    const retracted = store.resolveLocally("r3", 1_800)
    expect(retracted?.status).toBe("stale")
    expect(store.get("t3")?.status).toBe("stale")
  })

  test("resolveLocally leaves an action that is being written back from Feishu", () => {
    const store = newStore()
    store.create({ actionToken: "t11", connectionID: "c1", request: request("r11"), allowedOpenIds: ["ou"], createdAt: 1_000, expiresAt: 5_000 })
    store.claim("t11", "ou", 1_500)
    expect(store.resolveLocally("r11", 1_600)).toBeUndefined()
    expect(store.get("t11")?.status).toBe("processing")
    expect(store.findByRequest("r11")?.status).toBe("processing")

    store.settle("t11", "completed", 1_700)
    expect(store.resolveLocally("r11", 1_800)).toBeUndefined()
    expect(store.get("t11")?.status).toBe("completed")
  })

  test("markConnectionStale affects only open actions on that connection", () => {
    const store = newStore()
    store.create({ actionToken: "t4", connectionID: "c1", request: request("r4"), allowedOpenIds: ["ou"], createdAt: 1_000, expiresAt: 5_000 })
    store.create({ actionToken: "t5", connectionID: "c2", request: request("r5"), allowedOpenIds: ["ou"], createdAt: 1_000, expiresAt: 5_000 })
    const stale = store.markConnectionStale("c1", 2_000)
    expect(stale.map((row) => row.actionToken)).toEqual(["t4"])
    expect(store.get("t5")?.status).toBe("pending")
    expect(store.activeCount()).toBe(1)
  })

  test("expireDue expires only overdue pending actions", () => {
    const store = newStore()
    store.create({ actionToken: "t6", connectionID: "c1", request: request("r6"), allowedOpenIds: ["ou"], createdAt: 1_000, expiresAt: 1_500 })
    store.create({ actionToken: "t7", connectionID: "c1", request: request("r7"), allowedOpenIds: ["ou"], createdAt: 1_000, expiresAt: 9_000 })
    const expired = store.expireDue(2_000)
    expect(expired.map((row) => row.actionToken)).toEqual(["t6"])
    expect(store.get("t7")?.status).toBe("pending")
  })

  test("markAllOpenStale retires every open action and leaves settled ones", () => {
    const store = newStore()
    store.create({ actionToken: "t8", connectionID: "c1", request: request("r8"), allowedOpenIds: ["ou"], createdAt: 1_000, expiresAt: 9_000 })
    store.create({ actionToken: "t9", connectionID: "c2", request: request("r9"), allowedOpenIds: ["ou"], createdAt: 1_000, expiresAt: 9_000 })
    store.create({ actionToken: "t10", connectionID: "c2", request: request("r10"), allowedOpenIds: ["ou"], createdAt: 1_000, expiresAt: 9_000 })
    store.claim("t9", "ou", 1_100)
    store.settle("t10", "completed", 1_200)

    const retired = store.markAllOpenStale(2_000)
    expect(retired.map((row) => row.actionToken).sort()).toEqual(["t8", "t9"])
    expect(store.get("t10")?.status).toBe("completed")
    expect(store.activeCount()).toBe(0)
  })
})

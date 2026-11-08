import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin from "../src/index.js"
import { belongsToLocation, createV2Host, setupV2, type V2PluginContext } from "../src/server/host-v2.js"
import { readRemoteState, writeRemoteState } from "../src/remote.js"

const ENV_KEYS = [
  "OPENCODE_FEISHU_APP_ID",
  "OPENCODE_FEISHU_APP_SECRET",
  "OPENCODE_FEISHU_RECEIVE_ID",
  "OPENCODE_FEISHU_ALLOWED_OPENID",
  "OPENCODE_FEISHU_WEBHOOK",
  "OPENCODE_FEISHU_SOCKET",
  "OPENCODE_FEISHU_SERVER_URL",
  "OPENCODE_FEISHU_SERVER_PASSWORD",
  "OPENCODE_PASSWORD",
  "OPENCODE_SERVER_PASSWORD",
  "XDG_STATE_HOME",
] as const

let dir: string
let savedEnv: Record<string, string | undefined>
let savedFetch: typeof fetch

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-notifier-v2-"))
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.OPENCODE_FEISHU_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/test-only"
  process.env.OPENCODE_FEISHU_SOCKET = path.join(dir, "broker.sock")
  savedFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = savedFetch
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

function context(overrides: Partial<V2PluginContext> = {}): V2PluginContext {
  return {
    app: { version: "2.2.6" },
    location: { directory: "/home/user/project" },
    options: {},
    event: {
      subscribe: async function* () {},
    },
    session: {
      get: async () => ({ id: "s1", title: "Root", location: { directory: "/home/user/project" } }),
    },
    permission: {
      reply: async () => {},
    },
    ...overrides,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await Bun.sleep(10)
  }
}

describe("OpenCode 2 host", () => {
  test("loads sessions from location.directory and replies to permissions with sessionID", async () => {
    const calls: unknown[] = []
    const host = createV2Host(
      context({
        permission: {
          reply: async (input) => {
            calls.push(input)
          },
        },
      }),
    )
    expect(await host.loadSession("s1")).toEqual({
      id: "s1",
      title: "Root",
      directory: "/home/user/project",
    })
    await host.replyPermission("p1", "s1", "once")
    expect(calls).toEqual([{ sessionID: "s1", requestID: "p1", decision: "once" }])
  })

  test("writes form answers through the local HTTP endpoint", async () => {
    process.env.OPENCODE_FEISHU_SERVER_URL = `http://127.0.0.1:${String(4000 + Math.floor(Math.random() * 1000))}`
    process.env.OPENCODE_FEISHU_SERVER_PASSWORD = "secret"
    const requests: { url: string; method: string; body: string | undefined; authorization: string | null }[] = []
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
        authorization: new Headers(init?.headers).get("authorization"),
      })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    const host = createV2Host(context())
    await host.replyForm("s1", "f1", { q0: "A", q1: ["B"] })
    await host.cancelForm("s1", "f1")

    expect(requests[0]?.url).toEndWith("/api/session/s1/form/f1/reply")
    expect(requests[0]?.method).toBe("POST")
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ answer: { q0: "A", q1: ["B"] } })
    expect(requests[0]?.authorization).toStartWith("Basic ")
    expect(requests[1]?.method).toBe("DELETE")
    expect(requests[1]?.url).toContain("/api/session/s1/form/f1?message=")
  })

  test("subscribes to the OpenCode 2 execution lifecycle for idle detection", async () => {
    let types: readonly string[] | undefined
    const runtime = await setupV2(
      context({
        event: {
          subscribe: (options) => {
            types = options?.types
            return (async function* () {})()
          },
        },
      }),
    )
    await Bun.sleep(10)
    expect(types).toContain("session.execution.started")
    expect(types).toContain("session.execution.succeeded")
    await runtime?.()
  })

  test("registers status/setRemote RPC and flushes the shared switch", async () => {
    let handlers: Record<string, (input: unknown) => unknown> | undefined
    const runtime = await setupV2(
      context({
        rpc: {
          register: async (_definition, registered) => {
            handlers = registered as never
            return {}
          },
        },
      }),
    )
    expect(runtime).toBeTypeOf("function")
    expect(handlers?.status).toBeTypeOf("function")

    expect(await handlers!.status!({})).toMatchObject({ enabled: false, mode: "notify" })
    await handlers!.setRemote!({ enabled: true })
    expect(readRemoteState(path.join(dir, "remote.json")).enabled).toBe(true)

    await runtime!()
  })

  test("ignores events from another active location", async () => {
    writeRemoteState(path.join(dir, "remote.json"), true)
    const titles: string[] = []
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { card?: { header?: { title?: { content?: string } } } }
      titles.push(body.card?.header?.title?.content ?? "?")
      return new Response(JSON.stringify({ code: 0 }), { status: 200 })
    }) as unknown as typeof fetch

    const permission = (id: string, directory: string, sessionID: string) => ({
      type: "permission.asked",
      location: { directory },
      data: { id, sessionID, permission: "bash", patterns: ["git push"] },
    })

    const cleanup = await setupV2(
      context({
        event: {
          subscribe: async function* () {
            yield permission("p-foreign", "/home/user/other", "s2")
            yield permission("p-own", "/home/user/project", "s1")
          },
        },
      }),
    )

    await waitFor(() => titles.length >= 1)
    await Bun.sleep(50)
    expect(titles).toHaveLength(1)
    await cleanup?.()
  })

  test("routes no-location execution events by their session", async () => {
    writeRemoteState(path.join(dir, "remote.json"), true)
    const titles: string[] = []
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { card?: { header?: { title?: { content?: string } } } }
      titles.push(body.card?.header?.title?.content ?? "?")
      return new Response(JSON.stringify({ code: 0 }), { status: 200 })
    }) as unknown as typeof fetch

    const cleanup = await setupV2(
      context({
        session: {
          get: async ({ sessionID }: { sessionID: string }) => ({
            id: sessionID,
            title: sessionID,
            location: { directory: sessionID === "s1" ? "/home/user/project" : "/home/user/other" },
          }),
        },
        event: {
          subscribe: async function* () {
            for (const sessionID of ["s1", "s2"]) {
              yield { type: "session.execution.started", data: { sessionID } }
            }
            for (const sessionID of ["s1", "s2"]) {
              yield { type: "session.execution.succeeded", data: { sessionID } }
            }
          },
        },
      }),
    )

    await waitFor(() => titles.length >= 1)
    await Bun.sleep(50)
    expect(titles).toHaveLength(1)
    await cleanup?.()
  })

  test("routes no-location forms by their nested session", async () => {
    writeRemoteState(path.join(dir, "remote.json"), true)
    const titles: string[] = []
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { card?: { header?: { title?: { content?: string } } } }
      titles.push(body.card?.header?.title?.content ?? "?")
      return new Response(JSON.stringify({ code: 0 }), { status: 200 })
    }) as unknown as typeof fetch

    const form = (id: string, sessionID: string) => ({
      type: "form.created",
      data: {
        form: {
          id,
          sessionID,
          metadata: { kind: "question" },
          fields: [{ key: "q0", title: "Header", description: "Pick one", type: "string", options: [{ label: "A" }] }],
        },
      },
    })

    const cleanup = await setupV2(
      context({
        session: {
          get: async ({ sessionID }: { sessionID: string }) => ({
            id: sessionID,
            title: sessionID,
            location: { directory: sessionID === "s1" ? "/home/user/project" : "/home/user/other" },
          }),
        },
        event: {
          subscribe: async function* () {
            yield form("f-foreign", "s2")
            yield form("f-own", "s1")
          },
        },
      }),
    )

    await waitFor(() => titles.length >= 1)
    await Bun.sleep(50)
    expect(titles).toHaveLength(1)
    await cleanup?.()
  })

  test("does not handle an event whose location lookup finishes after cleanup", async () => {
    writeRemoteState(path.join(dir, "remote.json"), true)
    const titles: string[] = []
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { card?: { header?: { title?: { content?: string } } } }
      titles.push(body.card?.header?.title?.content ?? "?")
      return new Response(JSON.stringify({ code: 0 }), { status: 200 })
    }) as unknown as typeof fetch

    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const cleanup = await setupV2(
      context({
        session: {
          get: async ({ sessionID }: { sessionID: string }) => {
            await gate
            return { id: sessionID, title: sessionID, location: { directory: "/home/user/project" } }
          },
        },
        event: {
          subscribe: async function* () {
            yield { type: "permission.asked", data: { id: "p-late", sessionID: "s1", permission: "bash", patterns: ["x"] } }
          },
        },
      }),
    )

    await cleanup?.()
    release?.()
    await Bun.sleep(50)
    expect(titles).toHaveLength(0)
  })

  test("routes events by workspace identity, not only directory", async () => {
    writeRemoteState(path.join(dir, "remote.json"), true)
    const titles: string[] = []
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { card?: { header?: { title?: { content?: string } } } }
      titles.push(body.card?.header?.title?.content ?? "?")
      return new Response(JSON.stringify({ code: 0 }), { status: 200 })
    }) as unknown as typeof fetch

    const cleanup = await setupV2(
      context({
        location: { directory: "/home/user/project", workspaceID: "w2" },
        session: {
          get: async ({ sessionID }: { sessionID: string }) => ({
            id: sessionID,
            title: sessionID,
            location: { directory: "/home/user/project" },
            workspaceID: sessionID === "s1" ? "w1" : "w2",
          }),
        },
        event: {
          subscribe: async function* () {
            for (const sessionID of ["s1", "s2"]) {
              yield { type: "session.execution.started", data: { sessionID } }
              yield { type: "session.execution.succeeded", data: { sessionID } }
            }
          },
        },
      }),
    )

    await waitFor(() => titles.length >= 1)
    await Bun.sleep(50)
    expect(titles).toHaveLength(1)
    await cleanup?.()
  })

  test("filters locations only when the event carries one", () => {
    expect(belongsToLocation({ location: { directory: "/home/user/other" } }, "/home/user/project")).toBe(false)
    expect(belongsToLocation({ location: { directory: "/home/user/project" } }, "/home/user/project")).toBe(true)
    expect(belongsToLocation({ type: "session.idle" }, "/home/user/project")).toBe(true)
  })

  test("filters by workspace when both sides have one", () => {
    const own = { directory: "/home/user/project", workspaceID: "w2" }
    expect(belongsToLocation({ location: { directory: "/home/user/project", workspaceID: "w1" } }, own)).toBe(false)
    expect(belongsToLocation({ location: { directory: "/home/user/project", workspaceID: "w2" } }, own)).toBe(true)
  })
})

describe("dual entrypoint detection", () => {
  test("setup runs with the real OpenCode 2 context", async () => {
    const cleanup = await plugin.setup(context())
    expect(cleanup).toBeTypeOf("function")
    await cleanup?.()
  })

  test("setup skips the context when any required V2 capability is missing", async () => {
    const full = context()
    const cases: V2PluginContext[] = [
      { ...full, event: undefined as never },
      { ...full, session: undefined as never },
      { ...full, permission: undefined as never },
    ]
    for (const ctx of cases) expect(await plugin.setup(ctx)).toBeUndefined()
  })

  test("setup ignores the degraded 1.19 config-plugin context", async () => {
    // OpenCode 1.19's internal V2 loader calls setup({options}) without event,
    // session or permission. Starting a runtime there would log an error and
    // duplicate the V1 runtime.
    expect(await plugin.setup({ options: {} } as V2PluginContext)).toBeUndefined()
  })

  test("server ignores input that is not a V1 plugin input", async () => {
    expect(await plugin.server({} as never, undefined)).toEqual({})
    expect(await plugin.server(context() as never, undefined)).toEqual({})
  })
})

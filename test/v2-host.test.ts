import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin from "../src/index.js"
import { createV2Host, setupV2, type V2PluginContext } from "../src/server/host-v2.js"
import { readRemoteState } from "../src/remote.js"

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

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import plugin from "../src/index.js"
import { writeRemoteState } from "../src/remote.js"

// The plugin reads its configuration from process.env; isolate every test from
// the developer's real Feishu setup and never touch the network.
const ENV_KEYS = [
  "OPENCODE_FEISHU_APP_ID",
  "OPENCODE_FEISHU_APP_SECRET",
  "OPENCODE_FEISHU_RECEIVE_ID",
  "OPENCODE_FEISHU_RECEIVE_ID_TYPE",
  "OPENCODE_FEISHU_ALLOWED_OPENID",
  "OPENCODE_FEISHU_WEBHOOK",
  "OPENCODE_FEISHU_SECRET",
  "OPENCODE_FEISHU_AT_USER_ID",
  "OPENCODE_FEISHU_SOCKET",
] as const

const sessions = new Map([["root", { id: "root", title: "Root task", directory: "/home/user/project" }]])

let dir: string
let remoteFile: string
let savedEnv: Record<string, string | undefined>
let savedFetch: typeof fetch
let titles: string[]
let logs: string[]

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-notifier-plugin-"))
  remoteFile = path.join(dir, "remote.json")
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.OPENCODE_FEISHU_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/test-only"
  process.env.OPENCODE_FEISHU_SOCKET = path.join(dir, "broker.sock")

  titles = []
  logs = []
  savedFetch = globalThis.fetch
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { card?: { header?: { title?: { content?: string } } } }
    titles.push(body.card?.header?.title?.content ?? "?")
    return new Response(JSON.stringify({ code: 0 }), { status: 200 })
  }) as unknown as typeof fetch
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

async function start() {
  const client = {
    app: {
      log: async ({ body }: { body: { level: string; message: string } }) => {
        logs.push(`${body.level} ${body.message}`)
      },
    },
    session: {
      get: async ({ path: { id } }: { path: { id: string } }) => ({ data: sessions.get(id) }),
    },
  }
  const hooks = await plugin.server({ client, directory: "/home/user/project" } as unknown as PluginInput, undefined)
  const emit = (type: string, properties: Record<string, unknown>) =>
    hooks.event?.({ event: { type, properties } as never })
  return { hooks, emit }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await Bun.sleep(10)
  }
}

const permission = { id: "p-1", sessionID: "root", permission: "bash", patterns: ["git push"] }
const question = {
  id: "q-1",
  sessionID: "root",
  questions: [{ header: "方案", question: "选哪个", options: [{ label: "A", description: "" }] }],
}

describe("plugin with the remote switch", () => {
  test("pushes immediately while the switch is on", async () => {
    writeRemoteState(remoteFile, true)
    const { hooks, emit } = await start()
    expect(logs.some((line) => line.includes("remote switch on"))).toBe(true)

    await emit("session.status", { sessionID: "root", status: { type: "busy" } })
    await emit("permission.asked", permission)
    await waitFor(() => titles.length === 1)
    await emit("permission.replied", { sessionID: "root", requestID: "p-1", reply: "once" })
    await emit("session.status", { sessionID: "root", status: { type: "idle" } })
    await hooks.dispose?.()

    expect(titles).toEqual(["[OpenCode] 等待权限确认", "[OpenCode] 任务已结束"])
  })

  test("stays silent while off and pushes what is still waiting once switched on", async () => {
    const { hooks, emit } = await start()
    expect(logs.some((line) => line.includes("remote switch off"))).toBe(true)

    await emit("session.status", { sessionID: "root", status: { type: "busy" } })
    await emit("permission.asked", permission)
    await emit("question.asked", question)
    await emit("permission.replied", { sessionID: "root", requestID: "p-1", reply: "once" })
    await Bun.sleep(100)
    expect(titles).toEqual([])

    writeRemoteState(remoteFile, true)
    await waitFor(() => titles.length === 1)
    await waitFor(() => logs.some((line) => line.includes("pushed 1 waiting request")))
    await hooks.dispose?.()

    expect(titles).toEqual(["[OpenCode] 等待你的决策"])
  }, 10_000)

  test("pushes a hand-written switch file the same way (no TUI needed)", async () => {
    // The switch is a plain file, so an environment without the TUI plugin can
    // enable pushes by writing it directly.
    fs.writeFileSync(remoteFile, '{"enabled": true}\n')
    const { hooks, emit } = await start()
    expect(logs.some((line) => line.includes("remote switch on"))).toBe(true)
    await emit("permission.asked", permission)
    await waitFor(() => titles.length === 1)
    await hooks.dispose?.()

    expect(titles).toEqual(["[OpenCode] 等待权限确认"])
  })

  test("tells the user how to turn the switch on when it is off", async () => {
    const { hooks } = await start()
    const line = logs.find((entry) => entry.includes("remote switch off"))
    expect(line).toContain("ctrl+x f")
    expect(line).toContain(remoteFile)
    await hooks.dispose?.()
  })
})

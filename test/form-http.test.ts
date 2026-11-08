import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { replyFormHTTP, resolveServerEndpoint } from "../src/opencode/form-http.js"

const KEYS = ["XDG_STATE_HOME", "OPENCODE_FEISHU_SERVER_URL", "OPENCODE_FEISHU_SERVER_PASSWORD", "OPENCODE_PASSWORD"] as const

let root: string
let saved: Record<string, string | undefined>
let savedFetch: typeof fetch

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "op-notifier-http-"))
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
  for (const key of KEYS) delete process.env[key]
  process.env.XDG_STATE_HOME = root
  savedFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = savedFetch
  for (const key of KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(root, { recursive: true, force: true })
})

function writeService(pid: number): void {
  const dir = path.join(root, "opencode")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "service.json"),
    JSON.stringify({ id: "svc", version: "2.2.6", url: "http://127.0.0.1:4999", pid, password: "pw" }),
  )
}

describe("OpenCode 2 form HTTP fallback", () => {
  test("uses the registered service only when it is this process", async () => {
    writeService(process.pid)
    expect(resolveServerEndpoint(process.env)).toEqual({
      url: "http://127.0.0.1:4999",
      headers: { authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}` },
    })

    writeService(process.pid + 1)
    expect(resolveServerEndpoint(process.env)).toBeUndefined()
  })

  test("posts the answer map and rejects a mismatched PID without network access", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    writeService(process.pid)
    await replyFormHTTP(process.env, "s1", "f1", { q0: "A" })
    expect(calls).toBe(1)

    writeService(process.pid + 1)
    await expect(replyFormHTTP(process.env, "s1", "f1", { q0: "A" })).rejects.toThrow()
    expect(calls).toBe(1)
  })

  test("prefers an explicit endpoint", () => {
    process.env.OPENCODE_FEISHU_SERVER_URL = "http://127.0.0.1:5000/"
    process.env.OPENCODE_FEISHU_SERVER_PASSWORD = "secret"
    expect(resolveServerEndpoint(process.env)?.url).toBe("http://127.0.0.1:5000")
  })
})

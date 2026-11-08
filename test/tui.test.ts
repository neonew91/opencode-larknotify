import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import tui from "../src/tui.js"

const ENV_KEYS = [
  "OPENCODE_FEISHU_APP_ID",
  "OPENCODE_FEISHU_APP_SECRET",
  "OPENCODE_FEISHU_RECEIVE_ID",
  "OPENCODE_FEISHU_ALLOWED_OPENID",
  "OPENCODE_FEISHU_WEBHOOK",
  "OPENCODE_FEISHU_SOCKET",
] as const

let dir: string
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-notifier-tui-"))
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.OPENCODE_FEISHU_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/test-only"
  process.env.OPENCODE_FEISHU_SOCKET = path.join(dir, "broker.sock")
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

function v2Context() {
  const layers: unknown[] = []
  const slots: unknown[] = []
  return {
    layers,
    slots,
    context: {
      options: {},
      // No RPC: the host must fall back to the shared remote.json file.
      client: {},
      keymap: {
        layer: (factory: () => unknown) => {
          layers.push(factory)
        },
        shortcuts: () => [],
      },
      ui: {
        toast: { show: () => {} },
        slot: (claim: unknown) => {
          slots.push(claim)
          return () => {}
        },
      },
      theme: {},
    },
  }
}

describe("TUI entrypoint detection", () => {
  test("mounts with the real OpenCode 2 TUI context", async () => {
    const { layers, slots, context } = v2Context()
    const cleanup = await tui.setup(context as never)
    expect(cleanup).toBeTypeOf("function")
    expect(layers.length).toBeGreaterThan(0)
    expect(slots.length).toBe(3)
    await cleanup?.()
  })

  test("skips the OpenCode 1 TUI api", async () => {
    const v1 = {
      options: {},
      keymap: { registerLayer: () => {}, getCommandBindings: () => new Map() },
      keys: { formatSequence: () => "" },
      ui: { toast: () => {} },
      slots: { register: () => {} },
      theme: { current: {} },
      lifecycle: { onDispose: () => {} },
    }
    expect(await tui.setup(v1 as never)).toBeUndefined()
  })

  test("skips the degraded 1.19 config-plugin context", async () => {
    expect(await tui.setup({ options: {} } as never)).toBeUndefined()
  })
})

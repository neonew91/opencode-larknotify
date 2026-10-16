import { describe, expect, test } from "bun:test"
import { DEFAULT_REMOTE_KEYBIND, parseTuiOptions, resolveBrokerConfig, resolvePluginRuntime } from "../src/options.js"

const INTERACTIVE_ENV = {
  OPENCODE_FEISHU_APP_ID: "cli_app",
  OPENCODE_FEISHU_APP_SECRET: "secret",
  OPENCODE_FEISHU_RECEIVE_ID: "oc_chat",
  OPENCODE_FEISHU_ALLOWED_OPENID: "ou_a, ou_b",
  OPENCODE_FEISHU_SOCKET: "/tmp/op-notifier-test/broker.sock",
}

describe("resolvePluginRuntime", () => {
  test("prefers interactive mode when an application bot is configured", () => {
    const runtime = resolvePluginRuntime(undefined, INTERACTIVE_ENV)
    expect(runtime.mode).toBe("interactive")
    if (runtime.mode !== "interactive") throw new Error("expected interactive")
    expect(runtime.interactive.socketPath).toBe("/tmp/op-notifier-test/broker.sock")
    expect(runtime.behavior.permissionRemote).toBe(true)
    expect(runtime.behavior.notifyOnQuestion).toBe(true)
  })

  test("falls back to notify mode with a webhook", () => {
    const runtime = resolvePluginRuntime(
      { permissionRemote: false },
      { OPENCODE_FEISHU_WEBHOOK: "https://open.feishu.cn/open-apis/bot/v2/hook/example" },
    )
    expect(runtime.mode).toBe("notify")
    if (runtime.mode !== "notify") throw new Error("expected notify")
    expect(runtime.webhook.webhook).toBe("https://open.feishu.cn/open-apis/bot/v2/hook/example")
    expect(runtime.behavior.permissionRemote).toBe(false)
  })

  test("disables when nothing is configured", () => {
    const runtime = resolvePluginRuntime(undefined, {})
    expect(runtime.mode).toBe("disabled")
  })

  test("disables on an unsafe webhook URL", () => {
    const runtime = resolvePluginRuntime(undefined, {
      OPENCODE_FEISHU_WEBHOOK: "http://example.com/open-apis/bot/v2/hook/example",
    })
    expect(runtime).toEqual({
      mode: "disabled",
      reason: "OPENCODE_FEISHU_WEBHOOK must be an HTTPS Feishu bot webhook",
    })
  })

  test("disables on invalid options", () => {
    const runtime = resolvePluginRuntime({ minimumDurationMs: -1 }, INTERACTIVE_ENV)
    expect(runtime).toEqual({ mode: "disabled", reason: "minimumDurationMs must be a non-negative number" })
  })
})

describe("parseTuiOptions", () => {
  test("defaults to <leader>f and a banner", () => {
    expect(parseTuiOptions(undefined)).toEqual({ value: { keybinds: [DEFAULT_REMOTE_KEYBIND], banner: true }, warnings: [] })
    expect(DEFAULT_REMOTE_KEYBIND).toBe("<leader>f")
  })

  test("accepts a key string, a key list, or disabling the shortcut", () => {
    expect(parseTuiOptions({ keybind: " ctrl+alt+f " }).value.keybinds).toEqual(["ctrl+alt+f"])
    expect(parseTuiOptions({ keybind: ["<leader>f", "f12"] }).value.keybinds).toEqual(["<leader>f", "f12"])
    expect(parseTuiOptions({ keybind: false }).value.keybinds).toEqual([])
    expect(parseTuiOptions({ keybind: "none" }).value.keybinds).toEqual([])
    expect(parseTuiOptions({ banner: false }).value.banner).toBe(false)
  })

  test("falls back to defaults with a warning on invalid values", () => {
    for (const keybind of [42, "", [], ["ok", 1], {}]) {
      const parsed = parseTuiOptions({ keybind })
      expect(parsed.value.keybinds).toEqual([DEFAULT_REMOTE_KEYBIND])
      expect(parsed.warnings).toHaveLength(1)
    }
    const parsed = parseTuiOptions({ banner: "yes" })
    expect(parsed.value.banner).toBe(true)
    expect(parsed.warnings).toEqual(["banner must be a boolean; using true"])
  })
})

describe("resolveBrokerConfig", () => {
  test("parses a complete configuration", () => {
    const result = resolveBrokerConfig(INTERACTIVE_ENV)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.value.allowedOpenIds).toEqual(["ou_a", "ou_b"])
    expect(result.value.receiveIdType).toBe("chat_id")
    expect(result.value.actionTtlMs).toBeGreaterThan(0)
  })

  test("requires at least one allowed open id", () => {
    const result = resolveBrokerConfig({ ...INTERACTIVE_ENV, OPENCODE_FEISHU_ALLOWED_OPENID: "" })
    expect(result).toEqual({
      ok: false,
      message: "OPENCODE_FEISHU_ALLOWED_OPENID must list at least one open_id",
    })
  })

  test("fails without application credentials", () => {
    const result = resolveBrokerConfig({})
    expect(result.ok).toBe(false)
  })
})

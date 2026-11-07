/**
 * RPC contract shared by the server plugin and the OpenCode 2 TUI plugin.
 *
 * This file intentionally has no runtime dependency on either plugin SDK.
 * OpenCode 2 resolves `context.client.rpc(contract)` from the server plugin's
 * registration; OpenCode 1 simply never loads the RPC entrypoint.
 */
export const LarkNotifyRpc = {
  id: "opencode-larknotify",
  methods: {
    status: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          mode: { type: "string", enum: ["interactive", "notify"] },
        },
        required: ["enabled", "mode"],
        additionalProperties: false,
      },
    },
    setRemote: {
      input: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
        },
        required: ["enabled"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
        },
        required: ["enabled"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const

export interface LarkNotifyStatus {
  enabled: boolean
  mode: "interactive" | "notify"
}

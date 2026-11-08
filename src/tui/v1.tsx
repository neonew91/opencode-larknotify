import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { resolvePluginRuntime } from "../options.js"
import { createRemoteSwitch, resolveRemoteStatePath, writeRemoteState } from "../remote.js"
import { SLASH_NAME, type HostTheme, type TuiHost, type TuiSlot } from "./shared.js"
import { mountTui } from "./ui.js"

/** OpenCode 1.x TUI entry. */
export const v1Tui: TuiPlugin = async (api, options) => {
  mountTui(createV1Host(api, options as Record<string, unknown> | undefined))
}

function createV1Host(api: TuiPluginApi, options: Record<string, unknown> | undefined): TuiHost {
  const available = resolvePluginRuntime(undefined, process.env).mode !== "disabled"
  const file = resolveRemoteStatePath(process.env)
  const remote = createRemoteSwitch(file)

  return {
    name: "v1",
    options,
    available,
    enabled: () => remote.enabled(),
    setEnabled: async (enabled) => {
      writeRemoteState(file, enabled)
      remote.check()
    },
    onChange: (handler) => {
      remote.start(handler)
      return () => remote.stop()
    },
    toast: (variant, title, message) => api.ui.toast({ variant, title, message }),
    registerCommand: (id, title, description, group, slash, run) => {
      api.keymap.registerLayer({
        commands: [
          {
            name: id,
            namespace: "palette",
            title,
            desc: description,
            category: group,
            slashName: slash,
            run,
          },
        ],
      })
    },
    registerKeybinds: (keys, commandID) => {
      if (keys.length === 0) return
      api.keymap.registerLayer({
        mode: "base",
        bindings: keys.map((key) => ({ key, cmd: commandID, desc: "切换飞书通知" })),
      })
    },
    shortcut: (commandID) => {
      try {
        const bindings = api.keymap
          .getCommandBindings({ visibility: "registered", commands: [commandID] })
          .get(commandID)
        const text = api.keys.formatSequence(bindings?.[0]?.sequence)
        return text || `/${SLASH_NAME}`
      } catch {
        return `/${SLASH_NAME}`
      }
    },
    registerSlot: (slot, render) => {
      const name = slotName(slot)
      api.slots.register({ order: 900, slots: { [name]: render } as never })
    },
    theme: (): HostTheme => ({
      success: api.theme.current.success,
      muted: api.theme.current.textMuted,
      backgroundElement: api.theme.current.backgroundElement,
      text: api.theme.current.text,
    }),
    onDispose: (fn) => {
      api.lifecycle.onDispose(fn)
    },
  }
}

function slotName(slot: TuiSlot): string {
  if (slot === "home") return "home_prompt_right"
  if (slot === "session") return "session_prompt_right"
  return "app_bottom"
}

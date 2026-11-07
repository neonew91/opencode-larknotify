import { parseTuiOptions, resolvePluginRuntime } from "../options.js"
import { REMOTE_POLL_MS, createRemoteSwitch, resolveRemoteStatePath, writeRemoteState } from "../remote.js"
import { LarkNotifyRpc, type LarkNotifyStatus } from "../rpc.js"
import { SLASH_NAME, TOGGLE_COMMAND, type HostTheme, type TuiHost, type TuiSlot } from "./shared.js"
import { mountTui } from "./ui.js"

/** The subset of the OpenCode 2.x TUI context this plugin uses. */
export interface V2TuiContext {
  options?: Record<string, unknown>
  // The generated client's rpc signature is generic; keep the host boundary
  // loose and narrow the two method results below.
  client: any
  keymap: {
    layer(factory: () => unknown): void
    shortcuts(id: string): readonly string[]
  }
  ui: {
    toast: { show(input: { variant?: string; title?: string; message: string }): void }
    slot(claim: unknown): () => void
  }
  theme?: {
    text?: {
      base?: unknown
      muted?: unknown
      feedback?: { success?: { base?: unknown } }
    }
    background?: { raised?: { base?: unknown } }
  }
}

/**
 * OpenCode 2 TUI entry. Prefer the server plugin RPC: it works when the TUI and
 * server are separate processes or machines. Older 2.x versions without RPC
 * fall back to the shared `remote.json` file.
 */
export function setupV2Tui(context: V2TuiContext): Promise<(() => void) | undefined> {
  return setup(context)
}

async function setup(context: V2TuiContext): Promise<(() => void) | undefined> {
  const host = await createV2Host(context)
  mountTui(host)
  return () => hostDispose(host)
}

async function createV2Host(context: V2TuiContext): Promise<V2Host> {
  const options = context.options
  const config = parseTuiOptions(options).value
  const cleanups: (() => void)[] = []
  let disposed = false
  const status = await probe(context)

  if (status) {
    let current = status.enabled
    const listeners = new Set<(enabled: boolean) => void>()
    const rpc = () => {
      if (!context.client.rpc) throw new Error("OpenCode 2 TUI client does not expose RPC")
      return context.client.rpc(LarkNotifyRpc as never)
    }
    const poll = setInterval(() => {
      void rpc()
        .status({})
        .then((value: unknown) => {
          const next = enabledOf(value)
          if (next === undefined) return
          current = next
          for (const handler of listeners) handler(next)
        })
        .catch(() => {
          // The server may be restarting; keep the last known state and retry.
        })
    }, REMOTE_POLL_MS)
    ;(poll as { unref?: () => void }).unref?.()

    return {
      name: "v2",
      options,
      available: true,
      enabled: () => current,
      setEnabled: async (enabled) => {
        const result = await rpc().setRemote({ enabled })
        const next = enabledOf(result)
        current = next ?? enabled
      },
      onChange: (handler) => {
        listeners.add(handler)
        return () => {
          listeners.delete(handler)
        }
      },
      toast: (variant, title, message) => {
        try {
          context.ui.toast.show({ variant, title, message })
        } catch {
          // An older TUI without toasts must not fail the plugin.
        }
      },
      registerCommand: (id, title, description, group, slash, run) => {
        try {
          context.keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id,
                title,
                description,
                group,
                palette: true,
                slash: { name: slash },
                ...(config.keybinds[0] ? { bind: config.keybinds[0] } : {}),
                run,
              },
            ],
          }))
        } catch {
          // An older 2.x TUI without this command shape must not fail the plugin.
        }
      },
      registerKeybinds: (keys, _commandID, run) => {
        const extra = keys.slice(1)
        if (extra.length === 0) return
        try {
          context.keymap.layer(() => ({
            mode: "global",
            commands: extra.map((key) => ({ bind: key, run })),
          }))
        } catch {
          // ignore unsupported keymap shape
        }
      },
      shortcut: (commandID) => {
        try {
          const text = context.keymap.shortcuts(commandID)[0]
          if (text) return text
        } catch {
          // fall through
        }
        return config.keybinds[0] ?? `/${SLASH_NAME}`
      },
      registerSlot: (slot, render) => {
        try {
          const unregister = context.ui.slot({
            append: v2Slot(slot),
            render: () => render() as never,
          })
          if (typeof unregister === "function") cleanups.push(unregister)
        } catch {
          // A missing slot path degrades silently on older 2.x releases.
        }
      },
      theme: (): HostTheme => ({
        success: context.theme?.text?.feedback?.success?.base,
        muted: context.theme?.text?.muted,
        backgroundElement: context.theme?.background?.raised?.base,
        text: context.theme?.text?.base,
      }),
      onDispose: (fn) => {
        cleanups.push(fn)
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        clearInterval(poll)
        for (const cleanup of cleanups.splice(0).reverse()) {
          try {
            cleanup()
          } catch {
            // ignore
          }
        }
      },
    }
  }

  // RPC is absent on older 2.x releases. Keep the file switch when Feishu is
  // configured for this process, matching the V1 behaviour.
  const available = resolvePluginRuntime(undefined, process.env).mode !== "disabled"
  const file = resolveRemoteStatePath(process.env)
  const remote = createRemoteSwitch(file)

  return {
    name: "v2",
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
    toast: (variant, title, message) => {
      try {
        context.ui.toast.show({ variant, title, message })
      } catch {
        // ignore unsupported toast shape
      }
    },
    registerCommand: (id, title, description, group, slash, run) => {
      try {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id,
              title,
              description,
              group,
              palette: true,
              slash: { name: slash },
              ...(config.keybinds[0] ? { bind: config.keybinds[0] } : {}),
              run,
            },
          ],
        }))
      } catch {
        // ignore unsupported keymap shape
      }
    },
    registerKeybinds: (keys, _commandID, run) => {
      const extra = keys.slice(1)
      if (extra.length === 0) return
      try {
        context.keymap.layer(() => ({
          mode: "global",
          commands: extra.map((key) => ({ bind: key, run })),
        }))
      } catch {
        // ignore unsupported keymap shape
      }
    },
    shortcut: (commandID) => {
      try {
        const text = context.keymap.shortcuts(commandID)[0]
        if (text) return text
      } catch {
        // fall through
      }
      return config.keybinds[0] ?? `/${SLASH_NAME}`
    },
    registerSlot: (slot, render) => {
      try {
        const unregister = context.ui.slot({
          append: v2Slot(slot),
          render: () => render() as never,
        })
        if (typeof unregister === "function") cleanups.push(unregister)
      } catch {
        // ignore unsupported slot shape
      }
    },
    theme: (): HostTheme => ({
      success: context.theme?.text?.feedback?.success?.base,
      muted: context.theme?.text?.muted,
      backgroundElement: context.theme?.background?.raised?.base,
      text: context.theme?.text?.base,
    }),
    onDispose: (fn) => {
      cleanups.push(fn)
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const cleanup of cleanups.splice(0).reverse()) {
        try {
          cleanup()
        } catch {
          // ignore
        }
      }
    },
  }
}

interface V2Host extends TuiHost {
  dispose(): void
}

function hostDispose(host: V2Host): void {
  host.dispose()
}

async function probe(context: V2TuiContext): Promise<LarkNotifyStatus | undefined> {
  if (typeof context.client?.rpc !== "function") return undefined
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const value = await withTimeout(context.client.rpc(LarkNotifyRpc as never).status({}), 1_000)
      const status = statusOf(value)
      if (status) return status
    } catch {
      // The server plugin may still be registering its RPC, or the server is
      // restarting. Keep retrying briefly, then fall back to the file switch.
    }
    if (attempt < 2) await delay(300)
  }
  return undefined
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("RPC timed out")), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function statusOf(value: unknown): LarkNotifyStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.enabled !== "boolean") return undefined
  if (record.mode !== "interactive" && record.mode !== "notify") return undefined
  return { enabled: record.enabled, mode: record.mode }
}

function enabledOf(value: unknown): boolean | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const enabled = (value as Record<string, unknown>).enabled
  return typeof enabled === "boolean" ? enabled : undefined
}

function v2Slot(slot: TuiSlot): string {
  if (slot === "home") return "home.footer.status"
  if (slot === "session") return "prompt.footer.status"
  return "app"
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { Show, createSignal, type Accessor } from "solid-js"
import { parseTuiOptions, resolvePluginRuntime } from "./options.js"
import { REMOTE_POLL_MS, readRemoteState, resolveRemoteStatePath, toggleRemoteState } from "./remote.js"

/**
 * TUI half of the plugin: a shortcut / command / slash command that flips the
 * Feishu remote switch, a badge beside the prompt and a banner while remote
 * mode is on. The server half (`index.ts`) reads the same switch file.
 */

const PLUGIN_ID = "opencode.feishu-webhook"
const TOGGLE_COMMAND = "feishu.notify.toggle"
const SLASH_NAME = "larknotify"

const tui: TuiPlugin = async (api, options) => {
  // Same mode selection as the server plugin: without Feishu there is nothing to switch.
  if (resolvePluginRuntime(undefined, process.env).mode === "disabled") return

  const { value: config, warnings } = parseTuiOptions(options)
  const file = resolveRemoteStatePath(process.env)
  const [enabled, setEnabled] = createSignal(readRemoteState(file).enabled)

  // Every OpenCode instance on this machine shares the switch; follow changes
  // made elsewhere (another TUI, or the file edited by hand).
  const timer = setInterval(() => {
    const next = readRemoteState(file).enabled
    if (next !== enabled()) setEnabled(next)
  }, REMOTE_POLL_MS)
  api.lifecycle.onDispose(() => clearInterval(timer))

  const toggle = (): void => {
    try {
      const next = toggleRemoteState(file)
      setEnabled(next.enabled)
      api.ui.toast(
        next.enabled
          ? {
              variant: "success",
              title: "飞书通知已开启",
              message: "question / permission 推送到飞书，可直接在手机上处理；等待中的请求会立即补推",
            }
          : { variant: "info", title: "飞书通知已关闭", message: "所有请求只在 OpenCode 内处理" },
      )
    } catch (error) {
      api.ui.toast({ variant: "error", title: "飞书通知", message: `切换失败：${describe(error)}` })
    }
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: TOGGLE_COMMAND,
        namespace: "palette",
        title: "切换飞书通知 (Feishu notify)",
        desc: "离开电脑时开启：question / permission 推送到飞书 (Feishu / Lark)，可直接在手机上处理",
        category: "Feishu",
        slashName: SLASH_NAME,
        run() {
          toggle()
        },
      },
    ],
  })
  if (config.keybinds.length > 0) {
    api.keymap.registerLayer({
      mode: "base",
      bindings: config.keybinds.map((key) => ({ key, cmd: TOGGLE_COMMAND, desc: "切换飞书通知" })),
    })
  }

  let shortcutCache: string | undefined
  const shortcut = (): string => {
    if (shortcutCache !== undefined) return shortcutCache
    let text = ""
    try {
      const bindings = api.keymap
        .getCommandBindings({ visibility: "registered", commands: [TOGGLE_COMMAND] })
        .get(TOGGLE_COMMAND)
      text = api.keys.formatSequence(bindings?.[0]?.sequence)
    } catch {
      text = ""
    }
    shortcutCache = text || `/${SLASH_NAME}`
    return shortcutCache
  }

  api.slots.register({
    order: 900,
    slots: {
      home_prompt_right() {
        return <Badge api={api} enabled={enabled} onToggle={toggle} />
      },
      session_prompt_right() {
        return <Badge api={api} enabled={enabled} onToggle={toggle} />
      },
      ...(config.banner
        ? {
            app_bottom() {
              return <Banner api={api} enabled={enabled} shortcut={shortcut} />
            },
          }
        : {}),
    },
  })

  if (warnings.length > 0) {
    api.ui.toast({ variant: "warning", title: "飞书通知插件配置", message: warnings.join("; ") })
  }
}

function Badge(props: { api: TuiPluginApi; enabled: Accessor<boolean>; onToggle: () => void }) {
  const theme = () => props.api.theme.current
  return (
    <text wrapMode="none" onMouseDown={() => props.onToggle()}>
      <Show when={props.enabled()} fallback={<span style={{ fg: theme().textMuted }}>○ 飞书通知</span>}>
        <span style={{ fg: theme().success, bold: true }}>● 飞书通知</span>
      </Show>
    </text>
  )
}

function Banner(props: { api: TuiPluginApi; enabled: Accessor<boolean>; shortcut: () => string }) {
  const theme = () => props.api.theme.current
  return (
    <Show when={props.enabled()}>
      <box
        width="100%"
        flexDirection="row"
        flexShrink={0}
        gap={2}
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={theme().backgroundElement}
      >
        <text fg={theme().success} wrapMode="none">
          <b>● 飞书通知已开启</b>
        </text>
        <text fg={theme().textMuted} wrapMode="none">
          question / permission 可直接在飞书处理
        </text>
        <box flexGrow={1} />
        <text fg={theme().textMuted} wrapMode="none">
          {props.shortcut()} 关闭
        </text>
      </box>
    </Show>
  )
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200)
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin

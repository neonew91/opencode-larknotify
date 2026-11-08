/** @jsxImportSource @opentui/solid */
import { Show, createSignal, type Accessor } from "solid-js"
import { parseTuiOptions } from "../options.js"
import { SLASH_NAME, TOGGLE_COMMAND, type TuiHost } from "./shared.js"

/**
 * Version-independent TUI: a command, optional keybinds, a badge and a banner.
 * The host adapter supplies the actual V1/V2 slot, keymap and theme APIs.
 */
export function mountTui(host: TuiHost): void {
  if (!host.available) return

  const { value: config, warnings } = parseTuiOptions(host.options)
  const initial = host.enabled()
  const [enabled, setEnabled] = createSignal(initial)

  host.onDispose(host.onChange((next) => setEnabled(next)))

  const toggle = (): void => {
    const desired = !enabled()
    void host
      .setEnabled(desired)
      .then(() => {
        // RPC may report a different final value (for example the server was
        // already switched by another TUI). Trust the host's state.
        const actual = host.enabled()
        setEnabled(actual)
        host.toast(
          actual ? "success" : "info",
          actual ? "飞书通知已开启" : "飞书通知已关闭",
          actual
            ? "question / permission 推送到飞书，可直接在手机上处理；等待中的请求会立即补推"
            : "所有请求只在 OpenCode 内处理",
        )
      })
      .catch((error: unknown) => {
        host.toast("error", "飞书通知", `切换失败：${describe(error)}`)
      })
  }

  host.registerCommand(
    TOGGLE_COMMAND,
    "切换飞书通知 (Feishu notify)",
    "离开电脑时开启：question / permission 推送到飞书 (Feishu / Lark)，可直接在手机上处理",
    "Feishu",
    SLASH_NAME,
    toggle,
  )
  if (config.keybinds.length > 0) host.registerKeybinds(config.keybinds, TOGGLE_COMMAND, toggle)

  host.registerSlot("home", () => <Badge host={host} enabled={enabled} onToggle={toggle} />)
  host.registerSlot("session", () => <Badge host={host} enabled={enabled} onToggle={toggle} />)
  if (config.banner) {
    host.registerSlot("banner", () => <Banner host={host} enabled={enabled} shortcut={() => host.shortcut(TOGGLE_COMMAND)} />)
  }

  if (warnings.length > 0) host.toast("warning", "飞书通知插件配置", warnings.join("; "))
}

function Badge(props: { host: TuiHost; enabled: Accessor<boolean>; onToggle: () => void }) {
  const theme = () => props.host.theme()
  return (
    <text wrapMode="none" onMouseDown={() => props.onToggle()}>
      <Show when={props.enabled()} fallback={<span style={{ fg: theme().muted }}>○ 飞书通知</span>}>
        <span style={{ fg: theme().success, bold: true }}>● 飞书通知</span>
      </Show>
    </text>
  )
}

function Banner(props: { host: TuiHost; enabled: Accessor<boolean>; shortcut: () => string }) {
  const theme = () => props.host.theme()
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
        <text fg={theme().muted} wrapMode="none">
          question / permission 可直接在飞书处理
        </text>
        <box flexGrow={1} />
        <text fg={theme().muted} wrapMode="none">
          {props.shortcut()} 关闭
        </text>
      </box>
    </Show>
  )
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200)
}

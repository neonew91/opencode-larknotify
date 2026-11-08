export const PLUGIN_ID = "opencode.larknotify"
export const TOGGLE_COMMAND = "feishu.notify.toggle"
export const SLASH_NAME = "larknotify"

export type ToastVariant = "info" | "success" | "warning" | "error"

export interface HostTheme {
  success: any
  muted: any
  backgroundElement: any
  text: any
}

export type TuiSlot = "home" | "session" | "banner"

/**
 * The small TUI surface the shared badge/banner/command code needs. V1 and V2
 * implement it with their respective APIs; everything above this line is
 * version-independent.
 */
export interface TuiHost {
  readonly name: "v1" | "v2"
  readonly options: Record<string, unknown> | undefined
  readonly available: boolean
  enabled(): boolean
  setEnabled(enabled: boolean): Promise<void>
  onChange(handler: (enabled: boolean) => void): () => void
  toast(variant: ToastVariant, title: string, message: string): void
  registerCommand(id: string, title: string, description: string, group: string, slash: string, run: () => void): void
  registerKeybinds(keys: string[], commandID: string, run: () => void): void
  shortcut(commandID: string): string
  registerSlot(slot: TuiSlot, render: () => unknown): void
  theme(): HostTheme
  onDispose(fn: () => void): void
}

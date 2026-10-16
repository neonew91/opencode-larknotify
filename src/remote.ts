import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { resolveSocketPath } from "./options.js"

/**
 * The remote switch decides whether OpenCode requests are pushed to Feishu.
 *
 * The TUI plugin writes the switch into `remote.json` beside the broker socket
 * and every server plugin (one per OpenCode process) polls it. A plain file
 * keeps all OpenCode instances on this machine in sync without touching the
 * broker protocol, and because it lives in the runtime directory the switch
 * falls back to "off" after a reboot.
 */

export interface RemoteState {
  enabled: boolean
  /** Time of the last change in ms; 0 when the switch was never written. */
  updatedAt: number
}

export interface RemoteSwitch {
  /** Last observed value of the switch. */
  enabled(): boolean
  state(): RemoteState
  /** Start polling; `onChange` runs whenever the switch flips. */
  start(onChange: (enabled: boolean) => void): void
  /** Re-read the file now and report a flip to the listener. */
  check(): RemoteState
  stop(): void
}

export const REMOTE_STATE_FILE = "remote.json"
export const REMOTE_POLL_MS = 1_000

export function resolveRemoteStatePath(env: Record<string, string | undefined> = process.env): string {
  return path.join(path.dirname(resolveSocketPath(env)), REMOTE_STATE_FILE)
}

/**
 * Read the switch without ever throwing. A missing, unreadable or malformed
 * file, a symlink, or a file owned by another user all mean "off".
 */
export function readRemoteState(file: string): RemoteState {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) return off()
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined
    if (uid !== undefined && stat.uid !== uid) return off()
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return off()
    const record = parsed as Record<string, unknown>
    const updatedAt = typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : 0
    return { enabled: record.enabled === true, updatedAt }
  } catch {
    return off()
  }
}

/** Persist the switch atomically (temp file + rename) so readers never see a partial write. */
export function writeRemoteState(file: string, enabled: boolean, now = Date.now()): RemoteState {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const state: RemoteState = { enabled, updatedAt: now }
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`)
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ ...state, pid: process.pid })}\n`, { mode: 0o600, flag: "wx" })
    fs.renameSync(temp, file)
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // ignore
    }
    throw error
  }
  return state
}

/** Flip the switch based on the file, not on a possibly stale in-memory copy. */
export function toggleRemoteState(file: string, now = Date.now()): RemoteState {
  return writeRemoteState(file, !readRemoteState(file).enabled, now)
}

export function createRemoteSwitch(file: string, intervalMs = REMOTE_POLL_MS): RemoteSwitch {
  let current = readRemoteState(file)
  let listener: ((enabled: boolean) => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  const check = (): RemoteState => {
    const next = readRemoteState(file)
    const flipped = next.enabled !== current.enabled
    current = next
    if (flipped) listener?.(next.enabled)
    return next
  }

  return {
    enabled: () => current.enabled,
    state: () => current,
    start(onChange) {
      listener = onChange
      if (timer) return
      timer = setInterval(() => {
        try {
          check()
        } catch {
          // a failing listener must not stop the polling loop
        }
      }, intervalMs)
      ;(timer as { unref?: () => void }).unref?.()
    },
    check,
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      listener = undefined
    },
  }
}

function off(): RemoteState {
  return { enabled: false, updatedAt: 0 }
}

import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export interface EnsureBrokerOptions {
  socketPath: string
  env: Record<string, string | undefined>
  logger?: (level: "debug" | "info" | "warn" | "error", message: string) => void
  readyTimeoutMs?: number
}

const LOCK_STALE_MS = 30_000

/**
 * Stop a broker that rejected this plugin (outdated protocol or stale token) so
 * that the next ensureBroker() starts one from the current code. Returns true
 * once the socket no longer answers.
 */
export async function retireBroker(pid: number, socketPath: string, timeoutMs = 5_000): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    // already gone
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await probe(socketPath))) return true
    await delay(100)
  }
  return !(await probe(socketPath))
}

export async function ensureBroker(options: EnsureBrokerOptions): Promise<{ token: string } | undefined> {
  const { socketPath, logger } = options
  const runtimeDir = path.dirname(socketPath)
  const lockPath = path.join(runtimeDir, "broker.lock")
  const tokenPath = path.join(runtimeDir, "broker.token")
  const logPath = path.join(runtimeDir, "broker.log")
  const readyTimeout = options.readyTimeoutMs ?? 10_000

  try {
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  } catch (error) {
    logger?.("error", `cannot create runtime dir: ${describe(error)}`)
    return undefined
  }

  if (await probe(socketPath)) {
    const token = readToken(tokenPath)
    if (token) return { token }
    logger?.("warn", "broker is up but token file is missing")
    return undefined
  }

  if (acquireLock(lockPath)) {
    try {
      const token = ensureToken(tokenPath)
      spawnBroker(options.env, logPath, logger)
      const ready = await waitForReady(socketPath, readyTimeout)
      if (!ready) {
        logger?.("error", "broker did not become ready in time")
        return undefined
      }
      return { token }
    } finally {
      releaseLock(lockPath)
    }
  }

  // Someone else is starting the broker; wait for it.
  const ready = await waitForReady(socketPath, readyTimeout)
  if (!ready) {
    logger?.("error", "timed out waiting for broker started by another process")
    return undefined
  }
  const token = readToken(tokenPath)
  return token ? { token } : undefined
}

function acquireLock(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600)
    fs.writeSync(fd, `${process.pid}\n`)
    fs.closeSync(fd)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    try {
      const stat = fs.statSync(lockPath)
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lockPath, { force: true })
        return acquireLock(lockPath)
      }
    } catch {
      // lock vanished between calls; let the caller fall back to waiting
    }
    return false
  }
}

function releaseLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { force: true })
  } catch {
    // ignore
  }
}

function ensureToken(tokenPath: string): string {
  const existing = readToken(tokenPath)
  if (existing) return existing
  const token = randomBytes(32).toString("hex")
  fs.writeFileSync(tokenPath, token, { mode: 0o600 })
  return token
}

function readToken(tokenPath: string): string | undefined {
  try {
    const value = fs.readFileSync(tokenPath, "utf8").trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

function spawnBroker(
  env: Record<string, string | undefined>,
  logPath: string,
  logger: EnsureBrokerOptions["logger"],
): void {
  const spawn = (globalThis as { Bun?: { spawn: (cmd: string[], opts: unknown) => { unref: () => void } } }).Bun?.spawn
  if (!spawn) throw new Error("Bun runtime is required to start the broker")

  const bun = resolveBunExecutable(env)
  const entry = fileURLToPath(new URL("../broker/entry.js", import.meta.url))
  const logFd = fs.openSync(logPath, "a")
  try {
    const proc = spawn([bun, entry], {
      env,
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
    })
    proc.unref()
    logger?.("info", `started feishu broker via ${bun}`)
  } finally {
    fs.closeSync(logFd)
  }
}

/**
 * Locate a real `bun` executable. In the OpenCode runtime `process.execPath`
 * points at the opencode binary, not bun, so the broker (which needs bun:sqlite
 * and Bun.listen) must be launched with an actual bun.
 */
function resolveBunExecutable(env: Record<string, string | undefined>): string {
  const explicit = env.OPENCODE_FEISHU_BUN?.trim()
  if (explicit && fs.existsSync(explicit)) return explicit

  const viaWhich = (globalThis as { Bun?: { which?: (cmd: string) => string | null } }).Bun?.which?.("bun")
  if (viaWhich && fs.existsSync(viaWhich)) return viaWhich

  const candidates = [
    env.BUN_INSTALL ? path.join(env.BUN_INSTALL, "bin", "bun") : undefined,
    env.HOME ? path.join(env.HOME, ".bun", "bin", "bun") : undefined,
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ].filter((value): value is string => Boolean(value))
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  if (/[\\/]bun(\.exe)?$/.test(process.execPath)) return process.execPath
  throw new Error("cannot locate the 'bun' executable; set OPENCODE_FEISHU_BUN to its absolute path")
}

async function waitForReady(socketPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe(socketPath)) return true
    await delay(200)
  }
  return probe(socketPath)
}

async function probe(socketPath: string): Promise<boolean> {
  const connect = (globalThis as { Bun?: { connect: (opts: unknown) => Promise<unknown> } }).Bun?.connect
  if (!connect) return false
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean, socket?: { end: () => void }) => {
      if (settled) return
      settled = true
      try {
        socket?.end()
      } catch {
        // ignore
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), 500)
    connect({
      unix: socketPath,
      socket: {
        open: (socket: { end: () => void }) => {
          clearTimeout(timer)
          finish(true, socket)
        },
        data: () => {},
        close: () => {},
        error: () => {
          clearTimeout(timer)
          finish(false)
        },
      },
    }).catch(() => {
      clearTimeout(timer)
      finish(false)
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

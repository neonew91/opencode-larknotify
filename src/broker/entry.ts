import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { resolveBrokerConfig } from "../options.js"
import { startBroker } from "./server.js"

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

function ensureToken(tokenPath: string): string {
  try {
    const value = fs.readFileSync(tokenPath, "utf8").trim()
    if (value.length > 0) return value
  } catch {
    // generate below
  }
  const token = randomBytes(32).toString("hex")
  fs.writeFileSync(tokenPath, token, { mode: 0o600 })
  return token
}

async function main(): Promise<void> {
  const result = resolveBrokerConfig(process.env)
  if (!result.ok) {
    console.error(`[broker] disabled: ${result.message}`)
    process.exit(1)
  }
  const config = result.value
  const runtimeDir = path.dirname(config.socketPath)
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })

  // Single-instance guard: a reachable socket means another broker already runs.
  if (await probe(config.socketPath)) {
    console.error("[broker] another broker is already running; exiting")
    process.exit(0)
  }
  // Remove a stale socket file left by a crashed broker.
  try {
    fs.rmSync(config.socketPath, { force: true })
  } catch {
    // ignore
  }

  const token = ensureToken(path.join(runtimeDir, "broker.token"))
  const dbPath = path.join(runtimeDir, "broker.db")
  startBroker(config, token, dbPath)
}

void main()

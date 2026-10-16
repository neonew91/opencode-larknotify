import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  createRemoteSwitch,
  readRemoteState,
  resolveRemoteStatePath,
  toggleRemoteState,
  writeRemoteState,
} from "../src/remote.js"

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-notifier-remote-"))
  file = path.join(dir, "remote.json")
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("resolveRemoteStatePath", () => {
  test("places the switch beside the broker socket", () => {
    expect(resolveRemoteStatePath({ OPENCODE_FEISHU_SOCKET: "/tmp/x/broker.sock" })).toBe("/tmp/x/remote.json")
    expect(resolveRemoteStatePath({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/run/user/1000/opencode-feishu/remote.json")
  })
})

describe("readRemoteState", () => {
  test("treats a missing file as off", () => {
    expect(readRemoteState(file)).toEqual({ enabled: false, updatedAt: 0 })
  })

  test("treats malformed content as off", () => {
    for (const content of ["", "{", "null", "[]", '"on"', '{"enabled":"yes"}', '{"enabled":1}']) {
      fs.writeFileSync(file, content)
      expect(readRemoteState(file).enabled).toBe(false)
    }
  })

  test("ignores a symlink and a directory", () => {
    const target = path.join(dir, "target.json")
    fs.writeFileSync(target, JSON.stringify({ enabled: true, updatedAt: 1 }))
    fs.symlinkSync(target, file)
    expect(readRemoteState(file).enabled).toBe(false)

    fs.rmSync(file)
    fs.mkdirSync(file)
    expect(readRemoteState(file).enabled).toBe(false)
  })

  test("accepts a hand-written file", () => {
    fs.writeFileSync(file, '{"enabled": true}\n')
    expect(readRemoteState(file)).toEqual({ enabled: true, updatedAt: 0 })
  })
})

describe("writeRemoteState / toggleRemoteState", () => {
  test("round-trips and flips based on the file", () => {
    expect(writeRemoteState(file, true, 10)).toEqual({ enabled: true, updatedAt: 10 })
    expect(readRemoteState(file)).toEqual({ enabled: true, updatedAt: 10 })
    expect(toggleRemoteState(file, 20)).toEqual({ enabled: false, updatedAt: 20 })
    expect(toggleRemoteState(file, 30)).toEqual({ enabled: true, updatedAt: 30 })
    expect(readRemoteState(file)).toEqual({ enabled: true, updatedAt: 30 })
  })

  test("writes a private file atomically without leftovers", () => {
    writeRemoteState(file, true)
    writeRemoteState(file, false)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(dir)).toEqual(["remote.json"])
  })

  test("creates the runtime directory when missing", () => {
    const nested = path.join(dir, "nested", "remote.json")
    writeRemoteState(nested, true)
    expect(readRemoteState(nested).enabled).toBe(true)
    expect(fs.statSync(path.dirname(nested)).mode & 0o777).toBe(0o700)
  })
})

describe("createRemoteSwitch", () => {
  test("reads the initial state", () => {
    writeRemoteState(file, true)
    expect(createRemoteSwitch(file).enabled()).toBe(true)
    expect(createRemoteSwitch(path.join(dir, "absent.json")).enabled()).toBe(false)
  })

  test("reports flips but not unchanged reads", () => {
    const remote = createRemoteSwitch(file, 60_000)
    const seen: boolean[] = []
    remote.start((enabled) => seen.push(enabled))

    remote.check()
    writeRemoteState(file, true)
    remote.check()
    remote.check()
    writeRemoteState(file, false)
    remote.check()
    fs.rmSync(file)
    remote.check()
    remote.stop()

    expect(seen).toEqual([true, false])
    expect(remote.enabled()).toBe(false)
  })

  test("polls the file on its own", async () => {
    const remote = createRemoteSwitch(file, 10)
    const seen: boolean[] = []
    remote.start((enabled) => seen.push(enabled))
    writeRemoteState(file, true)
    const deadline = Date.now() + 2_000
    while (seen.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    remote.stop()
    expect(seen).toEqual([true])
    expect(remote.enabled()).toBe(true)

    writeRemoteState(file, false)
    await Bun.sleep(50)
    expect(seen).toEqual([true])
  })

  test("keeps polling when the listener throws", async () => {
    const remote = createRemoteSwitch(file, 10)
    let calls = 0
    remote.start(() => {
      calls++
      throw new Error("listener failure")
    })
    writeRemoteState(file, true)
    await Bun.sleep(80)
    writeRemoteState(file, false)
    const deadline = Date.now() + 2_000
    while (calls < 2 && Date.now() < deadline) await Bun.sleep(10)
    remote.stop()
    expect(calls).toBe(2)
  })
})

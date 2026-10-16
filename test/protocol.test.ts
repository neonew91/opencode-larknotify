import { describe, expect, test } from "bun:test"
import { createNdjsonDecoder, encodeMessage, type BrokerMessage } from "../src/ipc/protocol.js"

describe("ndjson protocol", () => {
  test("encodes with a trailing newline", () => {
    const message: BrokerMessage = { type: "result", id: "1", ok: true }
    expect(encodeMessage(message)).toBe(`${JSON.stringify(message)}\n`)
  })

  test("decodes complete frames and buffers partial ones", () => {
    const decoder = createNdjsonDecoder()
    const first = decoder.push(`${JSON.stringify({ type: "ping", id: "a" })}\n${JSON.stringify({ type: "pong", id: "b" })}`)
    expect(first).toEqual([{ type: "ping", id: "a" }])

    const second = decoder.push("\n")
    expect(second).toEqual([{ type: "pong", id: "b" }])
  })

  test("skips malformed lines without throwing", () => {
    const decoder = createNdjsonDecoder()
    const out = decoder.push("not-json\n{\"type\":\"pong\",\"id\":\"c\"}\n")
    expect(out).toEqual([{ type: "pong", id: "c" }])
  })
})

describe("protocol compatibility", () => {
  test("accepts every supported plugin version and rejects others", async () => {
    const { PROTOCOL_VERSION, MIN_COMPATIBLE_PROTOCOL, isCompatibleProtocol } = await import("../src/ipc/protocol.js")
    expect(PROTOCOL_VERSION).toBe(2)
    expect(isCompatibleProtocol(MIN_COMPATIBLE_PROTOCOL)).toBe(true)
    expect(isCompatibleProtocol(PROTOCOL_VERSION)).toBe(true)
    expect(isCompatibleProtocol(PROTOCOL_VERSION + 1)).toBe(false)
    expect(isCompatibleProtocol(0)).toBe(false)
    expect(isCompatibleProtocol("2")).toBe(false)
  })
})

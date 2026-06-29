/**
 * P3 — malformed tool-input repair wired into the streaming decoder.
 *
 * Drives the REAL captured malformed fixtures (1304 antml-bleed, 965-class
 * structural truncation) through `createToolInputStreamDecoder` with
 * `repairMalformedInput` on, asserting the forwarded wire is repaired to valid
 * JSON, the synthetic re-emitted delta carries its `event:` line (so the
 * Anthropic SDK doesn't drop it), `server_tool_use` is never touched, and
 * `false` replays the original bytes verbatim (no behavior change when off).
 */
import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { AnthropicMessageResponse } from "~/lib/anthropic/client"
import type { StreamEvent } from "~/types/api/anthropic"

import {
  //
  createToolInputStreamDecoder,
  decodeToolInputBlocksInResponse,
  type DecodeFailureInfo,
} from "~/lib/anthropic/decode-tool-input"

// ── harness ──────────────────────────────────────────────────────────────
interface Ev {
  parsed: StreamEvent
  raw: ServerSentEventMessage
}
function make(obj: Record<string, unknown>, event: string): Ev {
  return { parsed: obj as unknown as StreamEvent, raw: { event, data: JSON.stringify(obj) } }
}
function start(index: number, name: string, type = "tool_use"): Ev {
  return make({ type: "content_block_start", index, content_block: { type, id: `t${index}`, name, input: {} } }, "content_block_start")
}
function delta(index: number, partialJson: string): Ev {
  return make({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partialJson } }, "content_block_delta")
}
function stop(index: number): Ev {
  return make({ type: "content_block_stop", index }, "content_block_stop")
}
/** Run a sequence, returning the raw forwarded SSE messages (keeps `event`). */
function runRaw(decoder: ReturnType<typeof createToolInputStreamDecoder>, evs: Array<Ev>): Array<ServerSentEventMessage> {
  const out: Array<ServerSentEventMessage> = []
  for (const ev of evs) out.push(...decoder.processEvent(ev.parsed, ev.raw))
  return out
}
const dataOf = (m: ServerSentEventMessage): Record<string, unknown> => JSON.parse(m.data as string) as Record<string, unknown>

const loadRaw = (file: string): string =>
  (JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "anthropic-messages", "malformed-tool-input", file), "utf8")) as { raw: string }).raw
const RAW_1304 = loadRaw("todowrite-antml-bleed-1304.json")
const RAW_JSONREPAIR = loadRaw("task-truncated-jsonrepair-1782641593660-64.json")

const noCfg = { fields: {}, all: false }

describe("createToolInputStreamDecoder — malformed tool-input repair (P3)", () => {
  test("repair=tags: real antml-bleed TodoWrite is repaired to valid JSON on the wire", () => {
    const d = createToolInputStreamDecoder(noCfg, { repairMalformedInput: "tags" })
    const out = runRaw(d, [start(0, "TodoWrite"), delta(0, RAW_1304), stop(0)])
    expect(out).toHaveLength(3) // start, single rebuilt delta, stop
    expect(dataOf(out[0]).type).toBe("content_block_start")
    expect(dataOf(out[2]).type).toBe("content_block_stop")
    const rebuilt = dataOf(out[1]) as { type: string; delta: { partial_json: string } }
    expect(rebuilt.type).toBe("content_block_delta")
    const parsed = JSON.parse(rebuilt.delta.partial_json) as { todos: Array<unknown> }
    expect(parsed.todos).toHaveLength(6)
  })

  test("repair=tags: the re-emitted delta carries its event line (SDK dispatch invariant)", () => {
    const d = createToolInputStreamDecoder(noCfg, { repairMalformedInput: "tags" })
    const out = runRaw(d, [start(0, "TodoWrite"), delta(0, RAW_1304), stop(0)])
    const rebuilt = out.find((m) => dataOf(m).type === "content_block_delta")
    // A `data:`-only frame (event === undefined) is silently dropped by the Anthropic SDK.
    expect(rebuilt?.event).toBe("content_block_delta")
  })

  test("repair=repair: Layer 1 still suffices for the antml-bleed case (no jsonrepair needed)", () => {
    const d = createToolInputStreamDecoder(noCfg, { repairMalformedInput: "repair" })
    const out = runRaw(d, [start(0, "TodoWrite"), delta(0, RAW_1304), stop(0)])
    const rebuilt = dataOf(out[1]) as { delta: { partial_json: string } }
    expect((JSON.parse(rebuilt.delta.partial_json) as { todos: Array<unknown> }).todos).toHaveLength(6)
  })

  test("repair=repair: structural truncation is repaired via jsonrepair (Layer 2)", () => {
    const d = createToolInputStreamDecoder(noCfg, { repairMalformedInput: "repair" })
    const out = runRaw(d, [start(0, "Task"), delta(0, RAW_JSONREPAIR), stop(0)])
    expect(out).toHaveLength(3)
    const rebuilt = dataOf(out[1]) as { delta: { partial_json: string } }
    const parsed = JSON.parse(rebuilt.delta.partial_json) as { subagent_type: string; prompt: string }
    expect(parsed.subagent_type).toBe("general-purpose")
    expect(parsed.prompt).toContain("请给出")
  })

  test("repair=tags: a structural break jsonrepair-only case stays unrepaired → original deltas replayed", () => {
    // Layer 1 (tag strip) cannot fix missing brackets; P3 has no fail path yet, so it replays the
    // original malformed bytes verbatim (same as the pre-repair behavior). P4 adds the fail.
    const d = createToolInputStreamDecoder(noCfg, { repairMalformedInput: "tags" })
    const out = runRaw(d, [start(0, "Task"), delta(0, RAW_JSONREPAIR), stop(0)])
    expect(out).toHaveLength(3) // start, replayed-original delta, stop
    expect((dataOf(out[1]) as { delta: { partial_json: string } }).delta.partial_json).toBe(RAW_JSONREPAIR)
  })

  test("repair=false (default off): malformed input replays original bytes byte-identical", () => {
    const d = createToolInputStreamDecoder(noCfg, { repairMalformedInput: false })
    const out = runRaw(d, [start(0, "TodoWrite"), delta(0, RAW_1304), stop(0)])
    expect(out).toHaveLength(3)
    expect((dataOf(out[1]) as { delta: { partial_json: string } }).delta.partial_json).toBe(RAW_1304)
  })

  test("repair on: server_tool_use with malformed input is NOT buffered or repaired (passthrough)", () => {
    const d = createToolInputStreamDecoder(noCfg, { repairMalformedInput: "repair" })
    const out = runRaw(d, [start(0, "web_search", "server_tool_use"), delta(0, RAW_1304), stop(0)])
    // server_tool_use is excluded from buffering → every frame passes through untouched.
    expect(out).toHaveLength(3)
    expect((dataOf(out[1]) as { delta: { partial_json: string } }).delta.partial_json).toBe(RAW_1304)
  })

  test("repair on: a valid non-decode tool is buffered but replayed byte-identical (timing-only change)", () => {
    const d = createToolInputStreamDecoder(noCfg, { repairMalformedInput: "tags" })
    const out = runRaw(d, [start(0, "Read"), delta(0, '{"file_path":'), delta(0, '"/x"}'), stop(0)])
    // Buffered (repair-on buffers all tool_use) but valid → original deltas replayed, content unchanged.
    expect(out).toHaveLength(4) // start + 2 original deltas + stop
    expect((dataOf(out[1]) as { delta: { partial_json: string } }).delta.partial_json).toBe('{"file_path":')
    expect((dataOf(out[2]) as { delta: { partial_json: string } }).delta.partial_json).toBe('"/x"}')
  })
})

// ── non-streaming whole-response repair (P5) ───────────────────────────────
interface ToolUseBlock {
  type: string
  id: string
  name: string
  input: unknown
}
function makeResponse(input: unknown): { content: Array<ToolUseBlock> } & Record<string, unknown> {
  return {
    id: "msg_ns",
    type: "message",
    role: "assistant",
    model: "claude-opus-4.8",
    content: [{ type: "tool_use", id: "t0", name: "TodoWrite", input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

const decodeNS = (input: unknown, mode: "tags" | "repair" | false, failures: Array<DecodeFailureInfo>) =>
  decodeToolInputBlocksInResponse(
    makeResponse(input) as unknown as AnthropicMessageResponse,
    { fields: {}, all: false },
    { repairMalformedInput: mode, onDecodeFailure: (i) => failures.push(i) },
  ) as unknown as {
    content: Array<ToolUseBlock>
  }

describe("decodeToolInputBlocksInResponse — non-streaming malformed-string repair (P5)", () => {
  test("repair=tags: a malformed STRING input is repaired to a structured object", () => {
    const failures: Array<DecodeFailureInfo> = []
    const out = decodeNS(RAW_1304, "tags", failures)
    expect(typeof out.content[0].input).toBe("object")
    expect((out.content[0].input as { todos: Array<unknown> }).todos).toHaveLength(6)
    expect(failures).toHaveLength(0)
  })

  test("repair=repair: a structurally-truncated STRING input is repaired via jsonrepair", () => {
    const failures: Array<DecodeFailureInfo> = []
    const out = decodeNS(RAW_JSONREPAIR, "repair", failures)
    expect((out.content[0].input as { subagent_type: string }).subagent_type).toBe("general-purpose")
    expect(failures).toHaveLength(0)
  })

  test("unrepairable STRING input → block kept verbatim + input-unrepairable reported", () => {
    const failures: Array<DecodeFailureInfo> = []
    const out = decodeNS('{"a":1,,,}', "repair", failures)
    expect(out.content[0].input).toBe('{"a":1,,,}') // unchanged — the malformed original survives
    expect(failures.some((f) => f.reason === "input-unrepairable")).toBe(true)
  })

  test("repair off: a malformed STRING input is left untouched (no repair, no report)", () => {
    const failures: Array<DecodeFailureInfo> = []
    const out = decodeNS(RAW_1304, false, failures)
    expect(out.content[0].input).toBe(RAW_1304)
    expect(failures).toHaveLength(0)
  })

  test("the common case (object input) is untouched even with repair on", () => {
    const failures: Array<DecodeFailureInfo> = []
    const out = decodeNS({ todos: [] }, "repair", failures)
    expect(out.content[0].input).toEqual({ todos: [] })
    expect(failures).toHaveLength(0)
  })
})

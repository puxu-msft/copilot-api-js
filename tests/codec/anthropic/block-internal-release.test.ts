import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { StreamEvent } from "~/types/api/anthropic"

import { createToolInputStreamDecoder } from "~/lib/anthropic/decode-tool-input"
import { type DecodeToolInputConfig } from "~/lib/anthropic/decode-tool-input-core"
import { extractToolParamTypes } from "~/lib/anthropic/recover-tool-call/schema-extract"
import { createToolCallTextRecoverer } from "~/lib/anthropic/recover-tool-call/stream"

// ============================================================================
// Block-internal release invariant (spec §3.3) — VERIFICATION guard, not a rewrite.
//
// Invariant: a buffering rewrite must NOT hold any of a block's frames past a
// SUBSEQUENT block's commit boundary. The two buffering rewrites satisfy this
// natively, and this file pins that with independent oracles:
//   - tool-input-decode releases at its OWN `content_block_stop` (block-level
//     self-release, decode-tool-input.ts:274-278).
//   - recover-tool-call releases its held candidate at the NEXT
//     `content_block_start` via rollbackCandidate (stream.ts:134-138) — i.e.
//     BEFORE that next block's own commit (its `content_block_stop`).
//
// These tests are load-bearing: they select a real target so buffering ACTUALLY
// happens (deltas suppressed → `[]`), then prove release lands at the correct
// boundary. An empty cfg would buffer nothing and make the assertions vacuous.
// ============================================================================

interface Ev {
  parsed: StreamEvent
  raw: ServerSentEventMessage
}

function make(obj: Record<string, unknown>, event: string): Ev {
  return { parsed: obj as unknown as StreamEvent, raw: { event, data: JSON.stringify(obj) } }
}

/** Parse a forwarded SSE message's data back to an object for oracle assertions. */
function parse(msg: ServerSentEventMessage): Record<string, unknown> {
  return JSON.parse(msg.data as string) as Record<string, unknown>
}

// ============================================================================
// decode: releases block frames at its OWN content_block_stop
// ============================================================================

describe("tool-input-decode block-internal release", () => {
  const cfg: DecodeToolInputConfig = { fields: { AskUserQuestion: ["questions"] } }

  const start0 = make(
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t0", name: "AskUserQuestion", input: {} } },
    "content_block_start",
  )
  // Stringified `questions` array → decode rewrites it, exercising the finalize emit path.
  const delta0 = make(
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: String.raw`{"questions":"[{\"h\":1}]"}` } },
    "content_block_delta",
  )
  const stop0 = make({ type: "content_block_stop", index: 0 }, "content_block_stop")
  const start1 = make({ type: "content_block_start", index: 1, content_block: { type: "text" } }, "content_block_start")

  test("delta of a buffered target is suppressed (frame held, not forwarded)", () => {
    const d = createToolInputStreamDecoder(cfg)
    expect(d.processEvent(start0.parsed, start0.raw).map(parse)).toEqual([
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t0", name: "AskUserQuestion", input: {} } },
    ])
    // Load-bearing: an EMPTY result proves the block IS being buffered (held),
    // not passed through. Without buffering this assertion would fail.
    expect(d.processEvent(delta0.parsed, delta0.raw)).toEqual([])
  })

  test("block frames are released AT the block's own content_block_stop", () => {
    const d = createToolInputStreamDecoder(cfg)
    d.processEvent(start0.parsed, start0.raw)
    d.processEvent(delta0.parsed, delta0.raw) // held ([])
    const atStop = d.processEvent(stop0.parsed, stop0.raw).map(parse)

    // Released at THIS block's stop, not deferred to stream-end flush.
    expect(atStop.length).toBeGreaterThan(0)
    // Everything released belongs to block 0 (the decoded delta + its stop),
    // never a frame carrying a later index.
    for (const f of atStop) expect(f.index).toBe(0)
    // The decoded delta really carries the rewritten (structured) input.
    const decodedDelta = atStop.find((f) => f.type === "content_block_delta") as { delta: { partial_json: string } }
    expect(JSON.parse(decodedDelta.delta.partial_json)).toEqual({ questions: [{ h: 1 }] })
  })

  test("nothing from block 0 leaks into or past the next block's start boundary", () => {
    const d = createToolInputStreamDecoder(cfg)
    d.processEvent(start0.parsed, start0.raw)
    d.processEvent(delta0.parsed, delta0.raw)
    d.processEvent(stop0.parsed, stop0.raw) // block 0 fully released here
    // By the time block 1 opens, block 0 is done: only the text start passes,
    // no residual block-0 frame rides along.
    const atStart1 = d.processEvent(start1.parsed, start1.raw).map(parse)
    expect(atStart1).toEqual([{ type: "content_block_start", index: 1, content_block: { type: "text" } }])
    // flush at stream end has nothing left to drain — block 0 was released at its stop.
    expect(d.flush()).toEqual([])
  })
})

// ============================================================================
// recover: releases held candidate at the NEXT content_block_start (rollback),
// before that next block's own commit boundary
// ============================================================================

describe("recover-tool-call candidate release before next block commit", () => {
  const schemas = extractToolParamTypes([{ name: "Write", input_schema: { properties: { file_path: { type: "string" }, content: { type: "string" } } } }])
  const deps = { enabled: true, toolNames: new Set(["Write"]), toolSchemas: schemas }

  const ev = (obj: Record<string, unknown>): Ev => ({ parsed: obj as unknown as StreamEvent, raw: { data: JSON.stringify(obj) } })

  // A downgraded tool-call rendered as text; recoverable → forms a CANDIDATE at the text block stop.
  const downgradeText =
    '先写文件。\n\ncall\n<invoke name="Write">\n<parameter name="file_path">/a</parameter>\n<parameter name="content">x</parameter>\n</invoke>\n'

  test("candidate is held at its OWN text stop, released at the NEXT block's start", () => {
    const r = createToolCallTextRecoverer(deps)
    r.processEvent(...evPair(ev({ type: "message_start", message: { id: "msg_1" } })))
    r.processEvent(...evPair(ev({ type: "content_block_start", index: 0, content_block: { type: "text" } })))
    r.processEvent(...evPair(ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: downgradeText } })))

    // At the candidate text block's OWN stop, nothing is emitted — the candidate
    // is deliberately held (commit decision needs a later stop_reason).
    const atStop = r.processEvent(...evPair(ev({ type: "content_block_stop", index: 0 })))
    expect(atStop).toEqual([])

    // At the NEXT content_block_start, rollbackCandidate releases the held frames
    // (stopFrame + bufferedFrames) alongside the new start — i.e. BEFORE this next
    // block reaches its own content_block_stop. Candidate never crosses the next
    // block's commit boundary.
    const atNextStart = r.processEvent(...evPair(ev({ type: "content_block_start", index: 1, content_block: { type: "text" } })))
    const parsed = atNextStart.map(parse)
    expect(parsed.length).toBeGreaterThan(0)
    // The released set carries the candidate's own text stop (index 0) followed by
    // the next block's start (index 1) — proving release lands exactly at next start.
    expect(parsed.some((f) => f.type === "content_block_stop" && f.index === 0)).toBe(true)
    expect(parsed.at(-1)).toEqual({ type: "content_block_start", index: 1, content_block: { type: "text" } })
  })
})

/** Spread helper: turn an Ev into the (parsed, raw) argument pair for processEvent. */
function evPair(e: Ev): [StreamEvent, ServerSentEventMessage] {
  return [e.parsed, e.raw]
}

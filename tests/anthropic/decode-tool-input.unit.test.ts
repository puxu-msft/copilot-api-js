import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { StreamEvent } from "~/types/api/anthropic"

import {
  //
  createToolInputStreamDecoder,
  decodeToolInputBlocksInResponse,
  reportDecodeFailure,
  type DecodeFailureInfo,
} from "~/lib/anthropic/decode-tool-input"
import { type DecodeToolInputConfig } from "~/lib/anthropic/decode-tool-input-core"

// ============================================================================
// Event fixtures
// ============================================================================

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

const cfg = (fields: Record<string, Array<string>>, all = false): DecodeToolInputConfig => ({ fields, all })

/** Run a sequence through the decoder, returning the flat forwarded-data list (parsed). */
function run(decoder: ReturnType<typeof createToolInputStreamDecoder>, evs: Array<Ev>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const ev of evs) {
    for (const msg of decoder.processEvent(ev.parsed, ev.raw)) {
      out.push(JSON.parse(msg.data as string) as Record<string, unknown>)
    }
  }
  return out
}

// ============================================================================
// Streaming decoder
// ============================================================================

describe("createToolInputStreamDecoder", () => {
  test("decodes a buffered tool_use: start + N deltas + stop → start + single decoded delta + stop", () => {
    const d = createToolInputStreamDecoder(cfg({ AskUserQuestion: ["questions"] }))
    const out = run(d, [start(0, "AskUserQuestion"), delta(0, '{"questions":'), delta(0, String.raw`"[{\"h\":1}]"}`), stop(0)])

    expect(out).toHaveLength(3) // start, decoded delta, stop
    expect(out[0].type).toBe("content_block_start")
    expect(out[1].type).toBe("content_block_delta")
    expect(out[2].type).toBe("content_block_stop")

    const deltaOut = out[1] as { index: number; delta: { partial_json: string } }
    expect(deltaOut.index).toBe(0)
    // questions string decoded to an array
    expect(JSON.parse(deltaOut.delta.partial_json)).toEqual({ questions: [{ h: 1 }] })
  })

  test("passes through a non-target tool_use untouched (delta count preserved)", () => {
    const d = createToolInputStreamDecoder(cfg({ AskUserQuestion: ["questions"] }))
    const out = run(d, [start(0, "OtherTool"), delta(0, '{"a":'), delta(0, "1}"), stop(0)])
    // 1 start + 2 original deltas + 1 stop, nothing buffered
    expect(out).toHaveLength(4)
    expect(out[1]).toMatchObject({ type: "content_block_delta", delta: { partial_json: '{"a":' } })
    expect(out[2]).toMatchObject({ type: "content_block_delta", delta: { partial_json: "1}" } })
  })

  test("zero-perturbation: target tool with already-correct input replays original deltas", () => {
    const d = createToolInputStreamDecoder(cfg({ AskUserQuestion: ["questions"] }))
    const out = run(d, [start(0, "AskUserQuestion"), delta(0, '{"questions":'), delta(0, "[1,2]}"), stop(0)])
    // nothing to decode (questions already an array) → original 2 deltas replayed
    expect(out).toHaveLength(4)
    expect(out[1]).toMatchObject({ delta: { partial_json: '{"questions":' } })
    expect(out[2]).toMatchObject({ delta: { partial_json: "[1,2]}" } })
  })

  test("malformed JSON falls back to lossless replay of original deltas", () => {
    const d = createToolInputStreamDecoder(cfg({ AskUserQuestion: ["questions"] }))
    const out = run(d, [start(0, "AskUserQuestion"), delta(0, '{"questions":'), stop(0)]) // truncated, unparseable
    expect(out).toHaveLength(3)
    expect(out[1]).toMatchObject({ delta: { partial_json: '{"questions":' } })
    expect(out[2].type).toBe("content_block_stop")
  })

  test("empty input (no deltas) forwards start + stop only", () => {
    const d = createToolInputStreamDecoder(cfg({ AskUserQuestion: ["questions"] }))
    const out = run(d, [start(0, "AskUserQuestion"), stop(0)])
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe("content_block_start")
    expect(out[1].type).toBe("content_block_stop")
  })

  test("server_tool_use is never buffered, even with all=true", () => {
    const d = createToolInputStreamDecoder(cfg({}, true))
    const out = run(d, [start(0, "web_search", "server_tool_use"), delta(0, '{"q":'), delta(0, '"[1]"}'), stop(0)])
    // all deltas pass through unchanged
    expect(out).toHaveLength(4)
    expect(out[1]).toMatchObject({ delta: { partial_json: '{"q":' } })
    expect(out[2]).toMatchObject({ delta: { partial_json: '"[1]"}' } })
  })

  test("interleaved tool_use blocks decode independently per index", () => {
    const d = createToolInputStreamDecoder(cfg({}, true))
    const out = run(d, [start(0, "A"), start(1, "B"), delta(0, '{"q":'), delta(1, '{"r":'), delta(0, '"[1]"}'), delta(1, '"[2]"}'), stop(0), stop(1)])
    // start0, start1, then stop0 → [delta0', stop0], stop1 → [delta1', stop1]
    const deltas = out.filter((e) => e.type === "content_block_delta") as Array<{
      index: number
      delta: { partial_json: string }
    }>
    const byIndex = new Map(deltas.map((dd) => [dd.index, JSON.parse(dd.delta.partial_json)]))
    expect(byIndex.get(0)).toEqual({ q: [1] })
    expect(byIndex.get(1)).toEqual({ r: [2] })
  })

  test("flush replays buffered deltas for a block with no stop (interrupted stream)", () => {
    const d = createToolInputStreamDecoder(cfg({ AskUserQuestion: ["questions"] }))
    run(d, [start(0, "AskUserQuestion"), delta(0, '{"questions":'), delta(0, '"[1]"')])
    const flushed = d.flush().map((m) => JSON.parse(m.data as string) as Record<string, unknown>)
    expect(flushed).toHaveLength(2)
    expect(flushed[0]).toMatchObject({ delta: { partial_json: '{"questions":' } })
    expect(flushed[1]).toMatchObject({ delta: { partial_json: '"[1]"' } })
    // second flush is empty (buffer cleared)
    expect(d.flush()).toHaveLength(0)
  })

  test("non-content events pass through", () => {
    const d = createToolInputStreamDecoder(cfg({}, true))
    const ping = make({ type: "ping" }, "ping")
    const out = d.processEvent(ping.parsed, ping.raw)
    expect(out).toEqual([ping.raw])
  })

  test("undefined parsed (keepalive) passes raw through", () => {
    const d = createToolInputStreamDecoder(cfg({}, true))
    const raw: ServerSentEventMessage = { data: "" }
    expect(d.processEvent(undefined, raw)).toEqual([raw])
  })
})

// ============================================================================
// Non-streaming helper
// ============================================================================

describe("decodeToolInputBlocksInResponse", () => {
  const baseResponse = (content: Array<Record<string, unknown>>) =>
    ({ id: "msg_1", type: "message", role: "assistant", model: "m", content, stop_reason: "tool_use" }) as never

  test("decodes a tool_use block's stringified field", () => {
    const resp = baseResponse([
      { type: "text", text: "hi" },
      { type: "tool_use", id: "t1", name: "AskUserQuestion", input: { questions: '[{"h":1}]' } },
    ])
    const out = decodeToolInputBlocksInResponse(resp, cfg({ AskUserQuestion: ["questions"] }))
    expect(out).not.toBe(resp)
    const block = (out.content as Array<{ type: string; input?: { questions: unknown } }>)[1]
    expect(block.input?.questions).toEqual([{ h: 1 }])
  })

  test("returns the same reference when nothing changes", () => {
    const resp = baseResponse([{ type: "tool_use", id: "t1", name: "Other", input: { a: "1" } }])
    const out = decodeToolInputBlocksInResponse(resp, cfg({ AskUserQuestion: ["questions"] }))
    expect(out).toBe(resp)
  })

  test("does not mutate the original response", () => {
    const input = { questions: '[{"h":1}]' }
    const resp = baseResponse([{ type: "tool_use", id: "t1", name: "AskUserQuestion", input }])
    decodeToolInputBlocksInResponse(resp, cfg({ AskUserQuestion: ["questions"] }))
    expect(input.questions).toBe('[{"h":1}]')
  })
})

// ============================================================================
// Backfill (ToolInputRewriteOptions)
// ============================================================================

describe("createToolInputStreamDecoder — backfill", () => {
  const backfillOn = { backfillAskUserQuestionHeader: true }

  test("buffers AskUserQuestion for backfill even when decode does not select it", () => {
    const d = createToolInputStreamDecoder(cfg({}), backfillOn)
    const out = run(d, [start(0, "AskUserQuestion"), delta(0, '{"questions":[{"header":"H"}'), delta(0, "]}"), stop(0)])
    // start + single rewritten delta + stop
    expect(out).toHaveLength(3)
    const deltaOut = out[1] as { delta: { partial_json: string } }
    expect(JSON.parse(deltaOut.delta.partial_json)).toEqual({ questions: [{ header: "H", question: "H" }] })
  })

  test("decodes a stringified questions array, then backfills", () => {
    const d = createToolInputStreamDecoder(cfg({ AskUserQuestion: ["questions"] }), backfillOn)
    const out = run(d, [start(0, "AskUserQuestion"), delta(0, '{"questions":'), delta(0, String.raw`"[{\"header\":\"H\"}]"}`), stop(0)])
    expect(out).toHaveLength(3)
    const deltaOut = out[1] as { delta: { partial_json: string } }
    expect(JSON.parse(deltaOut.delta.partial_json)).toEqual({ questions: [{ header: "H", question: "H" }] })
  })

  test("no rewrite when backfill disabled and question already present", () => {
    const d = createToolInputStreamDecoder(cfg({}), backfillOn)
    const out = run(d, [start(0, "AskUserQuestion"), delta(0, '{"questions":[{"header":"H","question":"Q"}'), delta(0, "]}"), stop(0)])
    // present question → nothing changes → original 2 deltas replayed
    expect(out).toHaveLength(4)
    expect(out[1]).toMatchObject({ delta: { partial_json: '{"questions":[{"header":"H","question":"Q"}' } })
  })

  test("backfill off (default): missing question is left untouched", () => {
    const d = createToolInputStreamDecoder(cfg({}))
    const out = run(d, [start(0, "AskUserQuestion"), delta(0, '{"questions":[{"header":"H"}'), delta(0, "]}"), stop(0)])
    // not buffered at all → 1 start + 2 deltas + 1 stop
    expect(out).toHaveLength(4)
  })
})

describe("decodeToolInputBlocksInResponse — backfill", () => {
  const baseResponse = (content: Array<Record<string, unknown>>) =>
    ({ id: "msg_1", type: "message", role: "assistant", model: "m", content, stop_reason: "tool_use" }) as never
  const backfillOn = { backfillAskUserQuestionHeader: true }

  test("backfills missing question from header", () => {
    const resp = baseResponse([{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: { questions: [{ header: "H" }] } }])
    const out = decodeToolInputBlocksInResponse(resp, cfg({}), backfillOn)
    expect(out).not.toBe(resp)
    const block = (out.content as Array<{ input?: { questions: Array<Record<string, unknown>> } }>)[0]
    expect(block.input?.questions[0]).toEqual({ header: "H", question: "H" })
  })

  test("decodes stringified questions then backfills", () => {
    const resp = baseResponse([{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: { questions: '[{"header":"H"}]' } }])
    const out = decodeToolInputBlocksInResponse(resp, cfg({ AskUserQuestion: ["questions"] }), backfillOn)
    const block = (out.content as Array<{ input?: { questions: Array<Record<string, unknown>> } }>)[0]
    expect(block.input?.questions[0]).toEqual({ header: "H", question: "H" })
  })

  test("backfill off (default): missing question left untouched, same reference", () => {
    const resp = baseResponse([{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: { questions: [{ header: "H" }] } }])
    const out = decodeToolInputBlocksInResponse(resp, cfg({}))
    expect(out).toBe(resp)
  })
})

// ============================================================================
// onDecodeFailure (observability)
// ============================================================================

describe("createToolInputStreamDecoder — onDecodeFailure", () => {
  const sink = () => {
    const calls: Array<DecodeFailureInfo> = []
    return { calls, onDecodeFailure: (info: DecodeFailureInfo) => calls.push(info) }
  }
  const C = cfg({ AskUserQuestion: ["questions"] })

  test("fires field-undecodable when a configured field is a non-JSON string", () => {
    const { calls, onDecodeFailure } = sink()
    const d = createToolInputStreamDecoder(C, { onDecodeFailure })
    run(d, [start(0, "AskUserQuestion"), delta(0, '{"questions":'), delta(0, String.raw`"not json at all"}`), stop(0)])
    expect(calls).toEqual([{ tool: "AskUserQuestion", field: "questions", reason: "field-undecodable", valueLength: "not json at all".length }])
  })

  test("fires input-parse-failed when the whole buffered input JSON is malformed", () => {
    const { calls, onDecodeFailure } = sink()
    const d = createToolInputStreamDecoder(C, { onDecodeFailure })
    run(d, [start(0, "AskUserQuestion"), delta(0, '{"questions":'), stop(0)]) // truncated → unparseable
    expect(calls).toEqual([{ tool: "AskUserQuestion", reason: "input-parse-failed" }])
  })

  test("does NOT fire on successful decode (valid stringified array)", () => {
    const { calls, onDecodeFailure } = sink()
    const d = createToolInputStreamDecoder(C, { onDecodeFailure })
    run(d, [start(0, "AskUserQuestion"), delta(0, '{"questions":'), delta(0, String.raw`"[{\"h\":1}]"}`), stop(0)])
    expect(calls).toEqual([])
  })

  test("does NOT fire on flush (interrupted stream, no content_block_stop)", () => {
    const { calls, onDecodeFailure } = sink()
    const d = createToolInputStreamDecoder(C, { onDecodeFailure })
    run(d, [start(0, "AskUserQuestion"), delta(0, '{"questions":"not json"')]) // no stop
    d.flush()
    expect(calls).toEqual([]) // flush is a normal abort, never a decode failure
  })

  test("dedupes per (tool,field,reason) across multiple blocks in one request", () => {
    const { calls, onDecodeFailure } = sink()
    const d = createToolInputStreamDecoder(C, { onDecodeFailure })
    run(d, [start(0, "AskUserQuestion"), delta(0, '{"questions":"bad1"}'), stop(0), start(1, "AskUserQuestion"), delta(1, '{"questions":"bad2"}'), stop(1)])
    expect(calls).toHaveLength(1) // same tool:field:reason → reported once
  })

  test("does NOT fire under all=true for plain (non-explicit) string fields", () => {
    const { calls, onDecodeFailure } = sink()
    const d = createToolInputStreamDecoder(cfg({}, true), { onDecodeFailure })
    run(d, [start(0, "AnyTool"), delta(0, '{"note":'), delta(0, String.raw`"just text"}`), stop(0)])
    expect(calls).toEqual([]) // all-mode plain strings legitimately don't decode
  })

  test("partial: reports only the configured field that stayed a string", () => {
    const { calls, onDecodeFailure } = sink()
    const d = createToolInputStreamDecoder(cfg({ AskUserQuestion: ["questions", "extra"] }), { onDecodeFailure })
    run(d, [start(0, "AskUserQuestion"), delta(0, '{"questions":"[1]",'), delta(0, String.raw`"extra":"nope"}`), stop(0)])
    // questions decodes to [1] (no report); extra stays a string (reported)
    expect(calls).toEqual([{ tool: "AskUserQuestion", field: "extra", reason: "field-undecodable", valueLength: "nope".length }])
  })

  test("input-parse-failed fires for a backfill-only buffered tool (decode fields empty)", () => {
    const { calls, onDecodeFailure } = sink()
    const d = createToolInputStreamDecoder(cfg({}), { backfillAskUserQuestionHeader: true, onDecodeFailure })
    run(d, [start(0, "AskUserQuestion"), delta(0, '{"questions":'), stop(0)]) // buffered for backfill, malformed
    expect(calls).toEqual([{ tool: "AskUserQuestion", reason: "input-parse-failed" }])
  })
})

describe("decodeToolInputBlocksInResponse — onDecodeFailure", () => {
  const baseResponse = (content: Array<Record<string, unknown>>) =>
    ({ id: "m", type: "message", role: "assistant", model: "m", content, stop_reason: "tool_use" }) as never

  test("fires field-undecodable for a configured field that stays a string", () => {
    const calls: Array<DecodeFailureInfo> = []
    const resp = baseResponse([{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: { questions: "not json" } }])
    decodeToolInputBlocksInResponse(resp, cfg({ AskUserQuestion: ["questions"] }), { onDecodeFailure: (i) => calls.push(i) })
    expect(calls).toEqual([{ tool: "AskUserQuestion", field: "questions", reason: "field-undecodable", valueLength: "not json".length }])
  })

  test("does NOT fire on successful decode", () => {
    const calls: Array<DecodeFailureInfo> = []
    const resp = baseResponse([{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: { questions: '[{"h":1}]' } }])
    decodeToolInputBlocksInResponse(resp, cfg({ AskUserQuestion: ["questions"] }), { onDecodeFailure: (i) => calls.push(i) })
    expect(calls).toEqual([])
  })
})

describe("reportDecodeFailure", () => {
  test("records the tool-input-decode-failed feature with detail", () => {
    const features: Array<{ feature: string; detail?: Record<string, unknown> }> = []
    const ctx = { id: "req_1", recordFeature: (feature: string, detail?: Record<string, unknown>) => features.push({ feature, detail }) }
    reportDecodeFailure({ tool: "AskUserQuestion", field: "questions", reason: "field-undecodable", valueLength: 7 }, ctx as never)
    expect(features).toEqual([{ feature: "tool-input-decode-failed", detail: { tool: "AskUserQuestion", field: "questions", reason: "field-undecodable" } }])
  })
})

// ============================================================================
// AskUserQuestion top-level-key salvage/strip wiring (spec 2026-07-13)
// ============================================================================

/** Extract the (single) rebuilt tool_use input from a forwarded frame list. */
function forwardedInput(frames: Array<Record<string, unknown>>): Record<string, unknown> {
  const d = frames.find((f) => f.type === "content_block_delta") as { delta: { partial_json: string } } | undefined
  if (!d) throw new Error("no content_block_delta in forwarded frames")
  return JSON.parse(d.delta.partial_json) as Record<string, unknown>
}

describe("normalizeAskUserQuestionInput wiring", () => {
  const AUQ_CFG = cfg({ AskUserQuestion: ["questions"] })
  const OPTS = { backfillAskUserQuestionHeader: true }

  test("streaming finalize salvages a double-escaped top-level question and strips it (req_439 shape)", () => {
    const d = createToolInputStreamDecoder(AUQ_CFG, OPTS)
    // question is the 12-char literal `这次` (double-escaped); questions is a real array.
    const input = { questions: [{ header: "范围", multiSelect: false, options: [] }], question: String.raw`\u8fd9\u6b21` }
    const out = run(d, [start(0, "AskUserQuestion"), delta(0, JSON.stringify(input)), stop(0)])
    const fwd = forwardedInput(out) as { questions: Array<Record<string, unknown>>; question?: unknown }
    expect(fwd.questions[0].question).toBe("这次")
    expect("question" in fwd).toBe(false)
  })

  test("non-streaming decodeToolInputBlocksInResponse salvages + strips illegal top-level key", () => {
    const response = {
      content: [
        { type: "tool_use", name: "AskUserQuestion", input: { questions: [{ header: "范围", multiSelect: false, options: [] }], question: "怎么办？" } },
      ],
    }
    const out = decodeToolInputBlocksInResponse(response as never, AUQ_CFG, OPTS) as { content: Array<{ input: Record<string, unknown> }> }
    const blk = out.content[0].input as { questions: Array<Record<string, unknown>>; question?: unknown }
    expect("question" in blk).toBe(false)
    expect(blk.questions[0].question).toBe("怎么办？")
  })

  test("onNormalize callback fires with diag on salvage/strip", () => {
    const seen: Array<Record<string, unknown>> = []
    const response = {
      content: [
        { type: "tool_use", name: "AskUserQuestion", input: { questions: [{ header: "范围", multiSelect: false, options: [] }], question: "怎么办？" } },
      ],
    }
    decodeToolInputBlocksInResponse(response as never, AUQ_CFG, { ...OPTS, onNormalize: (dg) => seen.push(dg as Record<string, unknown>) })
    expect(seen[0]).toMatchObject({ salvaged: true, strippedKeys: ["question"] })
  })
})

describe("normalizeAskUserQuestionInput wiring — degraded config", () => {
  test("questions not decoded (config excludes AskUserQuestion): strip still traces dropped value, no salvage", () => {
    const seen: Array<Record<string, unknown>> = []
    // cfg has NO AskUserQuestion decode field → `questions` stays a stringified string (not array),
    // so salvage cannot fire; but strip still removes the illegal top-level `question` and traces it.
    const response = {
      content: [{ type: "tool_use", name: "AskUserQuestion", input: { questions: '[{"header":"h"}]', question: "real text" } }],
    }
    const out = decodeToolInputBlocksInResponse(response as never, cfg({}), {
      backfillAskUserQuestionHeader: true,
      onNormalize: (dg) => seen.push(dg as Record<string, unknown>),
    }) as { content: Array<{ input: Record<string, unknown> }> }
    expect("question" in out.content[0].input).toBe(false)
    expect(seen[0]).toMatchObject({ droppedQuestionValue: "real text" })
    expect(seen[0].salvaged).toBeUndefined()
  })
})

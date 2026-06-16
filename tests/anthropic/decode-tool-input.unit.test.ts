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

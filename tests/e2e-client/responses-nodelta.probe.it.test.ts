/**
 * GATING PROBE — Responses "no-delta block" client tolerance (Tier 1).
 *
 * Design question: when we BUFFER a Responses block (block-level buffered retry), can we DROP the
 * per-`.delta` frames (each carrying a giant `item_id`) and deliver only the block's terminal frames
 * (`output_item.added` + terminal `.done` + `output_item.done`), merging content — WITHOUT breaking a
 * real Responses client's reconstruction?
 *
 * A REAL `openai` SDK (`client.responses.stream(...).finalResponse()`) drives the REAL proxy over
 * genuine HTTP (in-process `Bun.serve`), GHC upstream shielded via `setUpstreamFetchForTests`. The
 * oracle is CLIENT-OBSERVABLE reconstruction (the SDK's ResponseAccumulator), not our forwarded bytes.
 *
 * KEY SOURCE FACT (node_modules/openai/lib/responses/ResponseAccumulator.js): the accumulator runs
 * per-event AS IT STREAMS, and `response.completed` REPLACES the whole snapshot
 * (`snapshot = cloneResponse(event.response)`). So finalResponse() is dominated by the completed
 * event's `output`, and mid-stream events that throw (e.g. output_text.done without a preceding
 * content_part.added) break the stream BEFORE completed can save it. These fixtures give completed a
 * FULL output (OpenAI-spec shape) to model reality and isolate the delta-drop question.
 */

import {
  //
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import OpenAI from "openai"

import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"
import { setUpstreamFetchForTests } from "~/lib/transport/upstream-fetch"

import type { BlockFixture } from "../responses/fixtures/buffered-merge-blocks"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  refusalBlock,
  reasoningContentBlock,
  reasoningSummaryBlock,
} from "../responses/fixtures/buffered-merge-blocks"
import {
  //
  type InProcessProxy,
  serveInProcess,
} from "./harness/serve-in-process"
import {
  //
  createSseResponse,
  scriptedUpstream,
} from "./harness/upstream-script"

const MODEL = "gpt-resp"

/** A Responses event-named SSE frame (event line = data.type). */
const ev = (obj: { type: string } & Record<string, unknown>): string => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`
const DONE = "data: [DONE]\n\n"

/** Adapter: the Task 0.3 fixtures produce ClientFrame `{event,data}` objects; the probe harness works
 *  with SSE strings. Convert a fixture's frames to the string form `finalOf` consumes. */
const fxSse = (fx: BlockFixture): Array<string> => fx.frames.map((f) => `event: ${f.event ?? ""}\ndata: ${f.data ?? ""}\n\n`)
/** Drop a specific `.added` frame from a fixture (the landmine mutant — its `.done` then throws in the SDK). */
const fxSseWithout = (fx: BlockFixture, droppedEvent: string): Array<string> =>
  fx.frames.filter((f) => f.event !== droppedEvent).map((f) => `event: ${f.event ?? ""}\ndata: ${f.data ?? ""}\n\n`)

const created = (): string =>
  ev({
    type: "response.created",
    sequence_number: 0,
    response: {
      id: "resp_up_1",
      object: "response",
      created_at: 1,
      status: "in_progress",
      model: MODEL,
      output: [],
      usage: null,
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
    },
  })

/**
 * completed carrying the FULL final output — the OpenAI-spec-correct shape (real OpenAI Responses
 * populates `response.output` on `response.completed`). The SDK's accumulator REPLACES the whole
 * snapshot on completed (`snapshot = cloneResponse(event.response)`), so finalResponse() is dominated
 * by THIS event, not the incremental deltas. (Whether GHC's DIRECT wire also populates it here is a
 * real-billed `live-ghc-e2e-verification` follow-up; this probe controls the wire to isolate CLIENT
 * tolerance.)
 */
const completedFull = (seq: number, output: Array<unknown>): string =>
  ev({
    type: "response.completed",
    sequence_number: seq,
    response: {
      id: "resp_up_1",
      object: "response",
      created_at: 1,
      status: "completed",
      model: MODEL,
      output,
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
    },
  })

const FC_ITEM = { id: "fc_1", type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}', status: "completed" }
const FC_ITEM_OPEN = { id: "fc_1", type: "function_call", call_id: "call_1", name: "get_weather", arguments: "", status: "in_progress" }

/** function_call WITH per-delta frames (positive control). */
function fcWithDeltas(): Array<string> {
  return [
    created(),
    ev({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: FC_ITEM_OPEN }),
    ev({ type: "response.function_call_arguments.delta", sequence_number: 2, output_index: 0, item_id: "fc_1", delta: '{"city":"Par' }),
    ev({ type: "response.function_call_arguments.delta", sequence_number: 3, output_index: 0, item_id: "fc_1", delta: 'is"}' }),
    ev({ type: "response.function_call_arguments.done", sequence_number: 4, output_index: 0, item_id: "fc_1", arguments: '{"city":"Paris"}' }),
    ev({ type: "response.output_item.done", sequence_number: 5, output_index: 0, item: FC_ITEM }),
    completedFull(6, [FC_ITEM]),
    DONE,
  ]
}

/** function_call with NO delta frames — only lifecycle + terminal .done (the merge shape). */
function fcNoDeltas(): Array<string> {
  return [
    created(),
    ev({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: FC_ITEM_OPEN }),
    // NO function_call_arguments.delta frames
    ev({ type: "response.function_call_arguments.done", sequence_number: 2, output_index: 0, item_id: "fc_1", arguments: '{"city":"Paris"}' }),
    ev({ type: "response.output_item.done", sequence_number: 3, output_index: 0, item: FC_ITEM }),
    completedFull(4, [FC_ITEM]),
    DONE,
  ]
}

const MSG_OPEN = { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] as Array<unknown> }
const MSG_DONE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "Hello world", annotations: [] }],
}

/** text WITH per-delta frames (positive control). */
function textWithDeltas(): Array<string> {
  return [
    created(),
    ev({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: MSG_OPEN }),
    ev({
      type: "response.content_part.added",
      sequence_number: 2,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    ev({ type: "response.output_text.delta", sequence_number: 3, output_index: 0, content_index: 0, delta: "Hello " }),
    ev({ type: "response.output_text.delta", sequence_number: 4, output_index: 0, content_index: 0, delta: "world" }),
    ev({ type: "response.output_text.done", sequence_number: 5, output_index: 0, content_index: 0, text: "Hello world" }),
    ev({
      type: "response.content_part.done",
      sequence_number: 6,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "Hello world", annotations: [] },
    }),
    ev({ type: "response.output_item.done", sequence_number: 7, output_index: 0, item: MSG_DONE }),
    completedFull(8, [MSG_DONE]),
    DONE,
  ]
}

/** text NO deltas, but KEEP the content_part lifecycle + output_item.done. */
function textNoDeltasKeepLifecycle(): Array<string> {
  return [
    created(),
    ev({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: MSG_OPEN }),
    ev({
      type: "response.content_part.added",
      sequence_number: 2,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    // NO output_text.delta frames
    ev({ type: "response.output_text.done", sequence_number: 3, output_index: 0, content_index: 0, text: "Hello world" }),
    ev({
      type: "response.content_part.done",
      sequence_number: 4,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "Hello world", annotations: [] },
    }),
    ev({ type: "response.output_item.done", sequence_number: 5, output_index: 0, item: MSG_DONE }),
    completedFull(6, [MSG_DONE]),
    DONE,
  ]
}

/** DANGER shape: output_text.done WITHOUT a preceding content_part.added (the merge naïvely dropped it). */
function textDoneWithoutContentPart(): Array<string> {
  return [
    created(),
    ev({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: MSG_OPEN }),
    // NO content_part.added, NO deltas
    ev({ type: "response.output_text.done", sequence_number: 2, output_index: 0, content_index: 0, text: "Hello world" }),
    ev({ type: "response.output_item.done", sequence_number: 3, output_index: 0, item: MSG_DONE }),
    completedFull(4, [MSG_DONE]),
    DONE,
  ]
}

/** ONLY output_item.added + output_item.done (the maximal merge — no terminal .done, no content_part). */
function textOnlyItemLifecycle(): Array<string> {
  return [
    created(),
    ev({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: MSG_OPEN }),
    ev({ type: "response.output_item.done", sequence_number: 2, output_index: 0, item: MSG_DONE }),
    completedFull(3, [MSG_DONE]),
    DONE,
  ]
}

interface FinalOutput {
  output: Array<{ type: string; arguments?: string; name?: string; content?: Array<{ type: string; text?: string }> }>
  output_text?: string
}

describe("GATING: Responses no-delta block — openai SDK reconstruction (upstream shielded)", () => {
  useIsolatedRuntime()

  let proxy: InProcessProxy
  let client: OpenAI

  beforeAll(() => {
    proxy = serveInProcess()
    client = new OpenAI({ baseURL: proxy.baseURL, apiKey: "test-key", maxRetries: 0 })
  })
  afterAll(() => proxy.close())

  beforeEach(() => {
    setStateForTests({
      copilotToken: "tok",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      normalizeResponsesCallIds: true,
      fixResponsesStreamIds: true,
      upstreamWebSocket: false,
    })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "OpenAI", supported_endpoints: ["/responses"] })] })
  })
  afterEach(() => setUpstreamFetchForTests(undefined))

  async function finalOf(frames: Array<string>): Promise<FinalOutput> {
    const up = scriptedUpstream(() => createSseResponse(frames))
    setUpstreamFetchForTests(up.handler)
    const final = (await client.responses.stream({ model: MODEL, input: "hi" }).finalResponse()) as unknown as FinalOutput
    return final
  }

  // ── function_call ─────────────────────────────────────────────────────────

  test("POSITIVE CONTROL: function_call WITH deltas → SDK reconstructs arguments", async () => {
    const final = await finalOf(fcWithDeltas())
    const fc = final.output.find((o) => o.type === "function_call")
    expect(fc?.name).toBe("get_weather")
    expect(fc?.arguments).toBe('{"city":"Paris"}')
  })

  test("GATING: function_call NO deltas (only output_item.done) → SDK reconstructs IDENTICALLY", async () => {
    const final = await finalOf(fcNoDeltas())
    const fc = final.output.find((o) => o.type === "function_call")
    expect(fc?.name).toBe("get_weather")
    expect(fc?.arguments).toBe('{"city":"Paris"}')
  })

  // ── text ──────────────────────────────────────────────────────────────────

  test("POSITIVE CONTROL: text WITH deltas → SDK reconstructs text", async () => {
    const final = await finalOf(textWithDeltas())
    const msg = final.output.find((o) => o.type === "message")
    expect(msg?.content?.[0]?.text).toBe("Hello world")
  })

  test("GATING: text NO deltas but content_part lifecycle kept → SDK reconstructs text", async () => {
    const final = await finalOf(textNoDeltasKeepLifecycle())
    const msg = final.output.find((o) => o.type === "message")
    expect(msg?.content?.[0]?.text).toBe("Hello world")
  })

  test("GATING (maximal merge): ONLY output_item.added + output_item.done → SDK reconstructs text", async () => {
    const final = await finalOf(textOnlyItemLifecycle())
    const msg = final.output.find((o) => o.type === "message")
    expect(msg?.content?.[0]?.text).toBe("Hello world")
  })

  // ── DANGER: naive merge that keeps output_text.done but drops content_part.added ──

  test("DANGER: output_text.done WITHOUT content_part.added → SDK stream THROWS mid-accumulation", async () => {
    // The SDK's ResponseAccumulator runs per-event; output_text.done calls getContent(content_index)
    // which throws "missing content" when the content part was never opened. This throw happens BEFORE
    // response.completed, so it breaks the stream even though completed carries the full output. Verdict:
    // a merge MUST NOT emit a terminal .done for a part whose .added it dropped — keep the FULL part
    // lifecycle, or collapse to output_item.added + output_item.done only (proven safe above).
    let threw: Error | undefined
    try {
      await finalOf(textDoneWithoutContentPart())
    } catch (err) {
      threw = err as Error
    }
    expect(threw).toBeInstanceOf(Error)
    expect(threw?.message).toContain("missing content")
  })

  test("DANGER: output_text.annotation.added WITHOUT content_part.added → SDK stream THROWS mid-accumulation", async () => {
    // Confirms item-summary MUST drop annotation.added together with content_part (never let one
    // survive without the other) — this is the concrete defect the GPT audit caught (Task 0.2b/2.3).
    const annotation = { type: "url_citation", start_index: 0, end_index: 5, url: "https://example.com", title: "Example" }
    const annotationAddedWithoutContentPart: Array<string> = [
      created(),
      ev({ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: MSG_OPEN }),
      // NO content_part.added
      ev({
        type: "response.output_text.annotation.added",
        sequence_number: 2,
        output_index: 0,
        content_index: 0,
        item_id: "msg_1",
        annotation_index: 0,
        annotation,
      }),
      ev({ type: "response.output_text.done", sequence_number: 3, output_index: 0, content_index: 0, text: "Hello world" }),
      ev({ type: "response.output_item.done", sequence_number: 4, output_index: 0, item: MSG_DONE }),
      completedFull(5, [MSG_DONE]),
      DONE,
    ]
    let threw: Error | undefined
    try {
      await finalOf(annotationAddedWithoutContentPart)
    } catch (err) {
      threw = err as Error
    }
    expect(threw).toBeInstanceOf(Error)
    expect(threw?.message).toContain("missing content")
  })

  test("completed dominance: created → completed(full output), NO item/delta events at all → SDK still reconstructs", async () => {
    // Proves WHY delta-dropping is safe for finalResponse: the accumulator replaces the whole snapshot
    // on response.completed. With a full-output completed, even ZERO incremental events reconstruct the
    // function call. (The per-delta item_id has NO value for a finalResponse consumer.)
    const final = await finalOf([created(), completedFull(1, [FC_ITEM]), DONE])
    const fc = final.output.find((o) => o.type === "function_call")
    expect(fc?.name).toBe("get_weather")
    expect(fc?.arguments).toBe('{"city":"Paris"}')
  })

  // ── passthrough control: the proxy does NOT re-expand the block into deltas ──

  test("passthrough: the proxy forwards the no-delta wire VERBATIM (client really sees NO delta frames)", async () => {
    // Guards the whole probe's validity: if the proxy re-synthesized deltas from the merged block, the
    // client would never see a no-delta wire and every "tolerance" claim above would be moot. Drive the
    // proxy with a raw fetch (not the SDK) and inspect the exact event lines it wrote to the client.
    setUpstreamFetchForTests(scriptedUpstream(() => createSseResponse(textOnlyItemLifecycle())).handler)
    const res = await fetch(`${proxy.baseURL}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
      body: JSON.stringify({ model: MODEL, input: "hi", stream: true }),
    })
    const wire = await res.text()
    const eventLines = [...wire.matchAll(/^event: (.+)$/gm)].map((m) => m[1])
    expect(eventLines).toContain("response.output_item.done")
    expect(eventLines.some((e) => e.endsWith(".delta"))).toBe(false) // proxy did NOT re-expand into deltas
  })

  // ── refusal + reasoning block types (spec §8.2 — the *.done landmine per block type) ──
  // Each block type's terminal `.done` (refusal.done / reasoning_text.done / reasoning_summary_text.done)
  // goes through the SDK accumulator's getContent(), so dropping its `.added` throws "missing content"
  // mid-stream — the same landmine output_text.done has. POSITIVE CONTROL proves the full sequence
  // reconstructs; GATING proves the mutant (dropped `.added`) throws.

  test("POSITIVE CONTROL: refusal block full sequence → SDK reconstructs a refusal message", async () => {
    const fx = refusalBlock(0, "msg_ref")
    const final = await finalOf([created(), ...fxSse(fx), completedFull(9, [fx.finalItem])])
    const msg = final.output.find((o) => o.type === "message")
    expect(msg?.content?.[0]?.type).toBe("refusal")
  })

  test("GATING (landmine): refusal.done without content_part.added → SDK throws missing content", async () => {
    const fx = refusalBlock(0, "msg_ref2")
    await expect(finalOf([created(), ...fxSseWithout(fx, "response.content_part.added")])).rejects.toThrow(/missing content/i)
  })

  test("POSITIVE CONTROL: reasoning summary block full sequence → SDK reconstructs a reasoning item", async () => {
    const fx = reasoningSummaryBlock(0, "rs_sum")
    const final = await finalOf([created(), ...fxSse(fx), completedFull(7, [fx.finalItem])])
    expect(final.output.some((o) => o.type === "reasoning")).toBe(true)
  })

  test("GATING (landmine): reasoning_summary_text.done without reasoning_summary_part.added → SDK throws missing content", async () => {
    const fx = reasoningSummaryBlock(0, "rs_sum2")
    await expect(finalOf([created(), ...fxSseWithout(fx, "response.reasoning_summary_part.added")])).rejects.toThrow(/missing content/i)
  })

  test("POSITIVE CONTROL: reasoning content-track block full sequence → SDK reconstructs a reasoning item", async () => {
    const fx = reasoningContentBlock(0, "rs_ct")
    const final = await finalOf([created(), ...fxSse(fx), completedFull(7, [fx.finalItem])])
    expect(final.output.some((o) => o.type === "reasoning")).toBe(true)
  })

  test("GATING (landmine): reasoning_text.done without content_part.added → SDK throws missing content", async () => {
    const fx = reasoningContentBlock(0, "rs_ct2")
    await expect(finalOf([created(), ...fxSseWithout(fx, "response.content_part.added")])).rejects.toThrow(/missing content/i)
  })
})

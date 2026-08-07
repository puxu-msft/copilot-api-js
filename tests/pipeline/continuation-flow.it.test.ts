/**
 * Driver-level continuation-retry FLOW tests (spec 2026-07-22 §4-§5, ADR D3). Drives the REAL
 * `runResponseBufferedSink` with a SEQUENCED transport (initial exchange cut mid-stream → a continuation
 * exchange via transport.send) + the continuation hooks, asserting the STITCHED client stream:
 *   - continuation fires instead of partial-degrade;
 *   - the continuation leg's duplicate message_start is dropped (exactly one on the wire);
 *   - continuation blocks are re-indexed by the WIRE-delivered block count (C3: counts thinking, which the
 *     ledger excludes — exp/continuation-stitch proved offset=ledger-length silently corrupts);
 *   - ADR D3: a committed interactive tool_use terminates (no continuation);
 *   - shared budget exhaustion → `continuation-exhausted`.
 *
 * The initial upstream is passed unbound, so the branch takes the `!parent → runPrimary` fallback (which
 * re-exchanges via transport.send); the `continued` parent-settlement is covered in
 * generation-coordinator.it.test.ts. Frame-stitching (the subject here) is identical on both paths.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  ClientFrame,
  ContinuationHooks,
  FormatCodec,
  PreparedRequest,
  RunBufferedOpts,
  Transport,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

import { extractAnthropicCommittedBlocks } from "~/lib/anthropic/committed-block-extractor"
import { buildAnthropicContinuationRequest } from "~/lib/anthropic/continuation-builder"
import {
  //
  createGenerationWireIndexAllocator,
  createGenerationWireState,
} from "~/lib/anthropic/keepalive-anchor"
import {
  //
  isAnthropicContentBlockStart,
  remapAnthropicBlockIndex,
} from "~/lib/anthropic/keepalive-anchor"
import { anthropicCommitBoundaries } from "~/lib/codec/anthropic/commit-boundaries"
import { createRequestContext } from "~/lib/context/request"
import { createCommittedBlocksLedger } from "~/lib/pipeline/committed-blocks-ledger"
import { createDownstreamDeliverySession } from "~/lib/pipeline/delivery/session"
import {
  //
  createPipelineDriver,
  type DriverDeps,
} from "~/lib/pipeline/driver"

import { FakeClock } from "../helpers/fake-clock"

function f(type: string, extra: Record<string, unknown> = {}): UpstreamFrame {
  return { event: type, data: JSON.stringify({ type, ...extra }) } as UpstreamFrame
}

/** yields the frames then returns (clean EOF = truncation when there is no message_stop). */
async function* gen(items: Array<UpstreamFrame>): AsyncIterable<UpstreamFrame> {
  for (const i of items) yield i
}
const up = (items: Array<UpstreamFrame>): UpstreamStream => ({ frames: gen(items), headers: new Headers() })

function makeCodec(): FormatCodec {
  return {
    format: "anthropic",
    parse: () => {
      throw new Error("parse not used")
    },
    translateOut: (env) => env,
    prepareWire: (env) => ({ url: "u", headers: new Headers(), body: env.body, stream: true }) as PreparedRequest,
    renderResponse: (frame) => frame,
    renderResponseNonStreaming: (u) => u,
    formatError: () => ({ event: "error", data: "{}" }) as ClientFrame,
    createResponseAccumulator: () => ({ model: "", inputTokens: 0, outputTokens: 0, rawContent: "" }),
  }
}

function makeEnv(): RequestEnvelope {
  const ctx = createRequestContext({ endpoint: "anthropic-messages" })
  return {
    clientFormat: "anthropic",
    targetEndpoint: "/v1/messages",
    model: {},
    stream: true,
    body: { model: "claude-opus-4", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
    view: {},
    prepareHints: {},
    ctx,
    with(patch: Partial<RequestEnvelope>): RequestEnvelope {
      return { ...this, ...patch } as unknown as RequestEnvelope
    },
  } as unknown as RequestEnvelope
}

/** driver whose transport.send returns the given re-exchange upstreams in sequence. */
function makeDriver(reexchanges: Array<UpstreamStream>, maxRetries = 3) {
  let sendCount = 0
  const sentBodies: Array<unknown> = []
  const transport: Transport = {
    send: (wire) => {
      sentBodies.push(wire.body)
      const u = reexchanges[sendCount] ?? reexchanges.at(-1)
      sendCount++
      return Promise.resolve(u ?? up([]))
    },
  }
  const deps: DriverDeps = { codec: makeCodec(), transport, strategies: [], maxRetries, maxLearningRetries: 32 }
  return { driver: createPipelineDriver(deps), sendCount: () => sendCount, sentBodies }
}

function makeStopTracker() {
  let saw = false
  return {
    onUpstreamFrame: (frame: UpstreamFrame) => {
      try {
        if ((JSON.parse(frame.data ?? "{}") as { type?: string }).type === "message_stop") saw = true
      } catch {
        /* ignore */
      }
    },
    onAttemptReset: () => (saw = false),
    sawMessageStop: () => saw,
  }
}

function arraySink(): { sink: import("~/lib/pipeline/types").ClientSink; written: Array<ClientFrame> } {
  const written: Array<ClientFrame> = []
  return { written, sink: { write: (frame: ClientFrame) => (written.push(frame), Promise.resolve()) } as import("~/lib/pipeline/types").ClientSink }
}

const continuationHooks: ContinuationHooks = {
  enabled: true,
  message: "network issue. please continue",
  isMessageStart: (fr) => {
    try {
      return typeof fr.data === "string" && (JSON.parse(fr.data) as { type?: string }).type === "message_start"
    } catch {
      return false
    }
  },
  isContentBlockStart: isAnthropicContentBlockStart,
  remap: remapAnthropicBlockIndex,
  buildRequest: (original, committed, message) => buildAnthropicContinuationRequest(original, committed, message),
}

/** parsed { type, index } view of a written frame. */
function seq(written: Array<ClientFrame>): Array<string> {
  return written.map((w) => {
    const p = JSON.parse(w.data as string) as { type: string; index?: number }
    return p.index === undefined ? p.type : `${p.type}@${p.index}`
  })
}

function bufferedOpts(
  ledger: ReturnType<typeof createCommittedBlocksLedger>,
  tracker: ReturnType<typeof makeStopTracker>,
  hooks: ContinuationHooks | undefined = continuationHooks,
): RunBufferedOpts {
  return {
    ...tracker,
    commitBoundaries: anthropicCommitBoundaries,
    committedBlocksLedger: ledger,
    extractCommittedBlocks: extractAnthropicCommittedBlocks,
    ...(hooks && { continuation: hooks }),
    retryCap: 3,
  } as RunBufferedOpts
}

describe("continuation-retry driver FLOW", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("mid-stream cut after a committed text block → continuation stitches (single message_start, re-indexed blocks)", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // initial: message_start + text@0 committed, then CUT (no message_stop).
    const initial = up([
      f("message_start", { message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } } }),
      f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "First half. " } }),
      f("content_block_stop", { index: 0 }),
    ])
    // continuation exchange: its OWN message_start (must be dropped) + text@0 (must remap to @1) + terminal.
    const continuation = up([
      f("message_start", { message: { id: "msg_2_dup", usage: { input_tokens: 50, output_tokens: 0 } } }),
      f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Second half." } }),
      f("content_block_stop", { index: 0 }),
      f("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } }),
      f("message_stop"),
    ])
    const { driver, sendCount, sentBodies } = makeDriver([continuation])
    const { sink: rawSink, written } = arraySink()
    const wireState = createGenerationWireState(createGenerationWireIndexAllocator())
    const delivery = createDownstreamDeliverySession({ sink: rawSink, wireState })
    const ledger = createCommittedBlocksLedger()
    const tracker = makeStopTracker()
    const opts = bufferedOpts(ledger, tracker)
    opts.wireAllocationPort = delivery.allocationPort

    const outcome = await driver.runResponseBufferedSink(initial, env, delivery.clientSink, opts)

    expect(outcome.kind).toBe("complete") // continuation succeeded, NOT partial-degrade
    expect(sendCount()).toBe(1) // one continuation exchange dispatched
    expect(wireState.activeLeg?.kind).toBe("continuation")
    expect(wireState.activeLeg?.source.candidateId).toContain("candidate")
    expect(wireState.activeLeg?.source.dispatchId).toContain("dispatch")

    const s = seq(written)
    // exactly one message_start (the continuation leg's duplicate dropped)
    expect(s.filter((x) => x === "message_start")).toHaveLength(1)
    // stitched, contiguous indices: delivered text@0 then continuation text remapped to @1
    expect(s).toEqual([
      "message_start",
      "content_block_start@0",
      "content_block_delta@0",
      "content_block_stop@0",
      "content_block_start@1",
      "content_block_delta@1",
      "content_block_stop@1",
      "message_delta",
      "message_stop",
    ])

    // the continuation upstream request = [original user] + [assistant = committed text] + [user = message]
    const contBody = sentBodies[0] as { messages: Array<{ role: string; content: unknown }> }
    expect(contBody.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "First half. " }] },
      { role: "user", content: "network issue. please continue" },
    ])
  })

  test("continuation format callback failure is codec-render, not a sink failure or retry", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    const initial = up([
      f("message_start", { message: { id: "msg_1" } }),
      f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "First." } }),
      f("content_block_stop", { index: 0 }),
    ])
    const continuation = up([
      f("message_start", { message: { id: "msg_2" } }),
      f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      f("message_stop"),
    ])
    const callbackError = new Error("network-shaped continuation predicate failure")
    const { driver, sendCount } = makeDriver([continuation])
    const { sink } = arraySink()
    const ledger = createCommittedBlocksLedger()
    const opts = bufferedOpts(ledger, makeStopTracker(), {
      ...continuationHooks,
      isMessageStart() {
        throw callbackError
      },
    })

    const outcome = await driver.runResponseBufferedSink(initial, env, sink, opts)

    expect(outcome).toMatchObject({ kind: "stream-error", source: "codec-render", error: callbackError })
    expect(sendCount()).toBe(1)
  })

  test("C3: thinking block delivered but excluded from ledger → continuation offset uses WIRE count, not ledger length", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // initial: thinking@0 + text@1 both committed (wire count 2), then CUT. Ledger holds only text (length 1).
    const initial = up([
      f("message_start", { message: { id: "msg_t", usage: { input_tokens: 1, output_tokens: 0 } } }),
      f("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      f("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } }),
      f("content_block_stop", { index: 0 }),
      f("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
      f("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Answer part 1. " } }),
      f("content_block_stop", { index: 1 }),
    ])
    const continuation = up([
      f("message_start", { message: { id: "msg_t2", usage: { input_tokens: 60, output_tokens: 0 } } }),
      f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Answer part 2." } }),
      f("content_block_stop", { index: 0 }),
      f("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } }),
      f("message_stop"),
    ])
    const { driver } = makeDriver([continuation])
    const { sink, written } = arraySink()
    const ledger = createCommittedBlocksLedger()

    const outcome = await driver.runResponseBufferedSink(initial, env, sink, bufferedOpts(ledger, makeStopTracker()))

    expect(outcome.kind).toBe("complete")
    // the ledger is CUMULATIVE and excludes thinking → it ends with both TEXT blocks, no thinking entry
    // (its length 1 at continuation-start ≠ the wire count 2 — that mismatch is exactly why the offset must
    // use the wire count, below).
    expect(ledger.snapshot()).toEqual([
      { type: "text", text: "Answer part 1. " },
      { type: "text", text: "Answer part 2." },
    ])
    const s = seq(written)
    expect(s).toContain("content_block_start@2") // continuation block re-indexed by wire count (thinking@0 + text@1)
    expect(s.filter((x) => x === "content_block_start@1")).toHaveLength(1) // the ONE delivered text block; NOT re-used
    // full contiguous shape: thinking@0, text@1, continuation text@2
    expect(s).toEqual([
      "message_start",
      "content_block_start@0",
      "content_block_delta@0",
      "content_block_stop@0",
      "content_block_start@1",
      "content_block_delta@1",
      "content_block_stop@1",
      "content_block_start@2",
      "content_block_delta@2",
      "content_block_stop@2",
      "message_delta",
      "message_stop",
    ])
  })

  test("ADR D3: a committed interactive tool_use terminates — NO continuation", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // initial: tool_use@0 committed, then CUT. D3 → the client runs the tool → no continuation.
    const initial = up([
      f("message_start", { message: { id: "msg_tu", usage: { input_tokens: 1, output_tokens: 0 } } }),
      f("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Write", input: {} } }),
      f("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } }),
      f("content_block_stop", { index: 0 }),
    ])
    const { driver, sendCount } = makeDriver([up([])])
    const { sink } = arraySink()
    const ledger = createCommittedBlocksLedger()

    const outcome = await driver.runResponseBufferedSink(initial, env, sink, bufferedOpts(ledger, makeStopTracker()))

    expect(outcome.kind).toBe("stream-error") // partial-degrade, not continued
    expect(sendCount()).toBe(0) // continuation never dispatched (D3 gate)
    expect(ledger.snapshot()).toEqual([{ type: "tool_use", id: "toolu_1", name: "Write", input: { path: "a.ts" } }])
  })

  test("continuation disabled → legacy partial-degrade (no continuation dispatched)", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    const initial = up([
      f("message_start", { message: { id: "msg_off", usage: { input_tokens: 1, output_tokens: 0 } } }),
      f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x" } }),
      f("content_block_stop", { index: 0 }),
    ])
    const { driver, sendCount } = makeDriver([up([])])
    const { sink } = arraySink()
    const ledger = createCommittedBlocksLedger()
    // continuation hooks present but enabled:false → branch not taken.
    const outcome = await driver.runResponseBufferedSink(initial, env, sink, bufferedOpts(ledger, makeStopTracker(), { ...continuationHooks, enabled: false }))
    expect(outcome.kind).toBe("stream-error")
    expect(sendCount()).toBe(0)
  })

  test("shared budget exhausts → continuation-exhausted (not infinite continuation)", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    let resolved: { outcome: string; retries: number; meta: { continuationRetries?: number } } | undefined
    const initial = up([
      f("message_start", { message: { id: "msg_b", usage: { input_tokens: 1, output_tokens: 0 } } }),
      f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "one" } }),
      f("content_block_stop", { index: 0 }),
    ])
    // every continuation leg commits a block then gets cut again → keeps trying until budget runs out.
    const cutLeg = (): UpstreamStream =>
      up([
        f("message_start", { message: { id: "dup", usage: { input_tokens: 5, output_tokens: 0 } } }),
        f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "more" } }),
        f("content_block_stop", { index: 0 }),
      ])
    const { driver, sendCount } = makeDriver([cutLeg(), cutLeg(), cutLeg(), cutLeg(), cutLeg()], 1) // maxRetries=1
    const { sink } = arraySink()
    const ledger = createCommittedBlocksLedger()
    const opts = bufferedOpts(ledger, makeStopTracker())
    opts.retryCap = 1 // shared budget cap = 1 → floor gives exactly ONE continuation, then exhausts
    opts.onBufferedResolve = (outcome, retries, meta) => (resolved = { outcome, retries, meta })

    const outcome = await driver.runResponseBufferedSink(initial, env, sink, opts)

    expect(outcome.kind).toBe("stream-error")
    expect(resolved?.outcome).toBe("continuation-exhausted") // NOT partial-degrade, NOT infinite
    expect(resolved?.meta.continuationRetries).toBeGreaterThan(0)
    // budget = cap - attempt - continuationCount; cap=1, floor 1 on first → exactly 1 continuation, then 0.
    expect(sendCount()).toBe(1)
  })

  // NOTE: chained continuation SUCCESS (primary → cont-1 cut → cont-2 success, stitched across 3 legs) is
  // asserted in the PRODUCTION path (tests/e2e-client/continuation-sdk.it.test.ts "CHAINED") — the mock
  // harness here cannot drive `runContinuation`'s candidate-session terminal detection across hops. The
  // cross-leg offset + cumulative ledger are therefore verified there; below locks only the graceful budget
  // degrade, which the mock CAN show.

  test("Important-2: a high budget that would exceed the generation candidate cap degrades gracefully (continuation-exhausted), never an unhandled throw", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // every leg commits a block then cuts → keeps continuing until the candidate cap (maxTotalCandidates,
    // derived as max(5, 1+deps.maxRetries)) is hit; the opts.retryCap budget (7) is DELIBERATELY larger so the
    // candidate cap is reached first — proving the dispatch failure degrades, not throws.
    const cutLeg = (): UpstreamStream =>
      up([
        f("message_start", { message: { id: "dup" } }),
        f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x" } }),
        f("content_block_stop", { index: 0 }),
      ])
    const initial = cutLeg()
    const { driver } = makeDriver([cutLeg(), cutLeg(), cutLeg(), cutLeg(), cutLeg(), cutLeg(), cutLeg()], 3) // deps.maxRetries=3 → candidate cap 5
    const { sink } = arraySink()
    const ledger = createCommittedBlocksLedger()
    let resolved: { outcome: string } | undefined
    const opts = bufferedOpts(ledger, makeStopTracker())
    opts.retryCap = 7 // budget larger than the candidate cap → the cap is hit first
    opts.onBufferedResolve = (outcome) => (resolved = { outcome })

    // Must NOT throw an unhandled "candidate budget exhausted" — best-effort continuation degrades.
    const outcome = await driver.runResponseBufferedSink(initial, env, sink, opts)

    expect(outcome.kind).toBe("stream-error")
    expect(resolved?.outcome).toBe("continuation-exhausted") // graceful terminal, not a crash
  })
})

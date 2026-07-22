/**
 * Driver-level integration tests for continuation-retry (spec 2026-07-22 §4-§5). Drives the REAL
 * `runResponseBufferedSink` with a committed-blocks ledger + the Anthropic extractor.
 *
 * Task 2.1 (this file, first test): the ledger records ONLY fully-committed blocks; a block cut
 * mid-generation (partial, never reaching its `content_block_stop` boundary) is NEVER recorded — it
 * stays in the driver buffer and is discarded on the RST.
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
  FormatCodec,
  PreparedRequest,
  RunBufferedOpts,
  Transport,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

import { extractAnthropicCommittedBlocks } from "~/lib/anthropic/committed-block-extractor"
import { anthropicCommitBoundaries } from "~/lib/codec/anthropic/commit-boundaries"
import { createRequestContext } from "~/lib/context/request"
import { createCommittedBlocksLedger } from "~/lib/pipeline/committed-blocks-ledger"
import {
  //
  createPipelineDriver,
  type DriverDeps,
} from "~/lib/pipeline/driver"

import { FakeClock } from "../helpers/fake-clock"

function f(type: string, extra: Record<string, unknown> = {}): UpstreamFrame {
  return { event: type, data: JSON.stringify({ type, ...extra }) } as UpstreamFrame
}

/** An upstream that yields all segments back-to-back then returns (clean EOF = truncation if no message_stop). */
function makeUpstream(frames: Array<UpstreamFrame>): UpstreamStream {
  async function* gen(): AsyncIterable<UpstreamFrame> {
    for (const fr of frames) yield fr
  }
  return { frames: gen(), headers: new Headers() }
}

function makeCodec(): FormatCodec {
  return {
    format: "anthropic",
    parse: () => {
      throw new Error("parse not used")
    },
    translateOut: (env) => env,
    prepareWire: () => ({ url: "u", headers: new Headers(), body: {}, stream: true }) as PreparedRequest,
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
    body: {},
    view: {},
    prepareHints: {},
    ctx,
    with(patch: Partial<RequestEnvelope>): RequestEnvelope {
      return { ...this, ...patch } as unknown as RequestEnvelope
    },
  } as unknown as RequestEnvelope
}

function makeDriver() {
  const transport: Transport = { send: () => Promise.reject(new Error("no re-exchange in this test")) }
  const deps: DriverDeps = { codec: makeCodec(), transport, strategies: [], maxRetries: 3, maxLearningRetries: 32 }
  return createPipelineDriver(deps)
}

function makeStopTracker() {
  let saw = false
  let sawErr = false
  return {
    onUpstreamFrame: (frame: UpstreamFrame) => {
      try {
        const t = (JSON.parse(frame.data ?? "{}") as { type?: string }).type
        if (t === "message_stop") saw = true
        if (t === "error") sawErr = true
      } catch {
        /* ignore */
      }
    },
    onAttemptReset: () => {
      saw = false
      sawErr = false
    },
    sawMessageStop: () => saw,
    sawUpstreamError: () => sawErr,
  }
}

function arraySink(): { sink: import("~/lib/pipeline/types").ClientSink; written: Array<ClientFrame> } {
  const written: Array<ClientFrame> = []
  return {
    written,
    sink: {
      write: (frame: ClientFrame) => (written.push(frame), Promise.resolve()),
    } as import("~/lib/pipeline/types").ClientSink,
  }
}

describe("continuation-retry driver — Task 2.1 ledger feed", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("ledger records only committed blocks; a mid-block-cut partial block is NOT recorded", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})

    // block@0: a full text block (commits at its content_block_stop → recorded).
    // block@1: a tool_use that starts + streams PARTIAL input_json, then the upstream truncates (clean EOF,
    //   no content_block_stop@1, no message_stop) → block@1 never reaches a boundary → NOT recorded.
    const up = makeUpstream([
      f("message_start", { message: { id: "msg_led", usage: { input_tokens: 1, output_tokens: 0 } } }),
      f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "done part" } }),
      f("content_block_stop", { index: 0 }),
      f("content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_x", name: "Write", input: {} } }),
      f("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts","cont' } }),
      // <-- truncation here (no content_block_stop@1, no message_stop)
    ])

    const driver = makeDriver()
    const { sink, written } = arraySink()
    const ledger = createCommittedBlocksLedger()
    const tracker = makeStopTracker()

    const outcome = await driver.runResponseBufferedSink(up, env, sink, {
      ...tracker,
      commitBoundaries: anthropicCommitBoundaries,
      committedBlocksLedger: ledger,
      extractCommittedBlocks: extractAnthropicCommittedBlocks,
      retryCap: 0,
    } as RunBufferedOpts)

    // committedAny → un-retryable truncation → partial-degrade surfaced as stream-error.
    expect(outcome.kind).toBe("stream-error")

    // Ledger holds ONLY the fully-committed block@0 — the partial tool_use block@1 was discarded.
    expect(ledger.snapshot()).toEqual([{ type: "text", text: "done part" }])

    // Sanity: the committed text block reached the client; the partial tool_use never committed to the wire.
    const types = written.map((w) => (JSON.parse(w.data as string) as { type: string }).type)
    expect(types).toContain("content_block_stop") // block@0's stop committed
    expect(written.some((w) => (w.data as string).includes("input_json_delta"))).toBe(false) // partial never flushed
  })

  test("ledger accumulates multiple committed blocks in commit order", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})

    const up = makeUpstream([
      f("message_start", { message: { id: "msg_led2", usage: { input_tokens: 1, output_tokens: 0 } } }),
      f("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      f("content_block_delta", { index: 0, delta: { type: "text_delta", text: "first" } }),
      f("content_block_stop", { index: 0 }),
      f("content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_y", name: "Read", input: {} } }),
      f("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"b.ts"}' } }),
      f("content_block_stop", { index: 1 }),
      f("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }),
      f("message_stop"),
    ])

    const driver = makeDriver()
    const { sink } = arraySink()
    const ledger = createCommittedBlocksLedger()
    const tracker = makeStopTracker()

    const outcome = await driver.runResponseBufferedSink(up, env, sink, {
      ...tracker,
      commitBoundaries: anthropicCommitBoundaries,
      committedBlocksLedger: ledger,
      extractCommittedBlocks: extractAnthropicCommittedBlocks,
      retryCap: 0,
    } as RunBufferedOpts)

    expect(outcome.kind).toBe("complete")
    expect(ledger.snapshot()).toEqual([
      { type: "text", text: "first" },
      { type: "tool_use", id: "toolu_y", name: "Read", input: { path: "b.ts" } },
    ])
  })
})

/**
 * L2 — runResponseBufferedSink unit tests (Phase 1, dead code until Phase 2 wires it).
 *
 * Drives the driver's transactional buffered-retry directly with a mock codec/transport +
 * a REAL RequestContext (so per-attempt `sseEvents` / the attempt model are exercised) and
 * a recording array sink. Asserts: a transport-close mid-stream RST re-exchanges and the
 * client receives ONLY the final complete generation; commit gates on `sawMessageStop`
 * (a clean drain WITHOUT message_stop = truncation → retry); client-abort never retries;
 * each attempt keeps its own upstream-original sseEvents (D1).
 *
 * See docs/rfc/streaming-upstream-rst-buffered-retry.md §3/§4/§15.
 */

import {
  //
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

import { createRequestContext } from "~/lib/context/request"
import { makeArraySink } from "~/lib/pipeline/client-sink"
import {
  //
  createPipelineDriver,
  type DriverDeps,
} from "~/lib/pipeline/driver"
import { ResponseCodecRenderError } from "~/lib/pipeline/stream/response-processor"
import { StreamClientAbortError } from "~/lib/stream"

// ── frame fixtures ──────────────────────────────────────────────────────────

function f(type: string, extra: Record<string, unknown> = {}): UpstreamFrame {
  return { event: type, data: JSON.stringify({ type, ...extra }) } as UpstreamFrame
}
const completeFrames = (msgId: string): Array<UpstreamFrame> => [
  f("message_start", { message: { id: msgId } }),
  f("content_block_start", { index: 0, content_block: { type: "tool_use", name: "Write" } }),
  f("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"x":1}' } }),
  f("content_block_stop", { index: 0 }),
  f("message_delta", { delta: { stop_reason: "tool_use" } }),
  f("message_stop"),
]
const partialFrames = (msgId: string): Array<UpstreamFrame> => [
  f("message_start", { message: { id: msgId } }),
  f("content_block_start", { index: 0, content_block: { type: "tool_use", name: "Write" } }),
  f("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"x":' } }),
]

async function* framesThenThrow(items: Array<UpstreamFrame>, error: Error): AsyncIterable<UpstreamFrame> {
  for (const i of items) yield i
  throw error
}
async function* framesClean(items: Array<UpstreamFrame>): AsyncIterable<UpstreamFrame> {
  for (const i of items) yield i
}
function upstream(frames: AsyncIterable<UpstreamFrame>): UpstreamStream {
  return { frames, headers: new Headers() }
}

const RST = (): Error => new Error("Stream closed with error code NGHTTP2_CANCEL")

// ── mock codec / driver ──────────────────────────────────────────────────────

function makeCodec(renderResponse: FormatCodec["renderResponse"] = (frame) => frame): FormatCodec {
  return {
    format: "anthropic",
    parse: () => {
      throw new Error("parse not used")
    },
    translateOut: (env) => env,
    prepareWire: () => ({ url: "u", headers: new Headers(), body: {}, stream: true }) as PreparedRequest,
    renderResponse, // identity by default (Anthropic bypass-direct)
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

/** A driver whose retry `transport.send` returns the given upstreams in sequence. */
function makeDriver(retryUpstreams: Array<UpstreamStream>, renderResponse: FormatCodec["renderResponse"] = (frame) => frame) {
  let sendCount = 0
  const transport: Transport = {
    send: () => {
      const u = retryUpstreams[sendCount] ?? retryUpstreams.at(-1)
      sendCount++
      return Promise.resolve(u)
    },
  }
  const deps: DriverDeps = { codec: makeCodec(renderResponse), transport, strategies: [], maxRetries: 3, maxLearningRetries: 32 }
  return { driver: createPipelineDriver(deps), sendCount: () => sendCount }
}

/** sawMessageStop tracker fed by onUpstreamFrame, reset per attempt. */
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
    onAttemptReset: () => {
      saw = false
    },
    sawMessageStop: () => saw,
  }
}

function sinkTypes(frames: Array<ClientFrame>): Array<string> {
  return frames.map((fr) => {
    try {
      return (JSON.parse(fr.data ?? "{}") as { type?: string }).type ?? "?"
    } catch {
      return "?"
    }
  })
}

describe("runResponseBufferedSink — L2 transactional buffered retry", () => {
  test.each([
    ["render network-shaped", "render", new Error("Stream closed with error code NGHTTP2_CANCEL")],
    ["render client-abort-shaped", "render", new StreamClientAbortError()],
    ["upstream callback network-shaped", "callback", new Error("Stream closed with error code NGHTTP2_CANCEL")],
  ])("codec processing failure (%s) bypasses retry and preserves codec-render provenance", async (_name, producer, processingError) => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    const renderResponse =
      producer === "render" ?
        () => {
          throw processingError
        }
      : (frame: UpstreamFrame) => frame
    const { driver, sendCount } = makeDriver([upstream(framesClean(completeFrames("must-not-recover")))], renderResponse)
    const { sink } = makeArraySink()
    const opts: RunBufferedOpts = {
      ...makeStopTracker(),
      retryCap: 1,
      ...(producer === "callback" && {
        onUpstreamFrame() {
          throw processingError
        },
      }),
    }

    const outcome = await driver.runResponseBufferedSink(upstream(framesClean([{ data: "render-me" }])), env, sink, opts)

    expect(outcome).toMatchObject({ kind: "stream-error", source: "codec-render", error: processingError })
    expect(sendCount()).toBe(0)
  })

  test("buffer transform preserves an already typed codec error without nesting", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    const original = new Error("buffer transform original")
    const typed = new ResponseCodecRenderError(original)
    const { driver, sendCount } = makeDriver([upstream(framesClean(completeFrames("must-not-recover")))])

    const outcome = await driver.runResponseBufferedSink(upstream(framesClean(completeFrames("transform-failure"))), env, makeArraySink().sink, {
      ...makeStopTracker(),
      retryCap: 1,
      transformBufferedFlush() {
        throw typed
      },
    } as RunBufferedOpts)

    expect(outcome).toMatchObject({ kind: "stream-error", source: "codec-render", error: original })
    if (outcome.kind === "stream-error") expect(outcome.error).toBe(original)
    expect(sendCount()).toBe(0)
  })

  test.each([
    ["anchor message-start predicate", "isMessageStart"],
    ["anchor block-start predicate", "isContentBlockStart"],
    ["anchor remap", "remap"],
  ])("anchor callback failure (%s) is codec-render rather than downstream-sink", async (_name, callback) => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    const callbackError = new Error(`anchor ${callback} failed`)
    const { driver, sendCount } = makeDriver([upstream(framesClean(completeFrames("must-not-recover")))])
    const anchor = {
      isMessageStart: () => {
        if (callback === "isMessageStart") throw callbackError
        return false
      },
      isContentBlockStart: () => {
        if (callback === "isContentBlockStart") throw callbackError
        return callback === "remap"
      },
      startFrame: () => ({ data: "start" }),
      stopFrame: () => ({ data: "stop" }),
      deltaFrame: () => ({ data: "delta" }),
      remap: (frame: ClientFrame) => {
        if (callback === "remap") throw callbackError
        return frame
      },
    } satisfies RunBufferedOpts["anchor"]
    const anchorState = { wireState: {} as never, injected: true, messageStartForwarded: true, anchorBlockOpen: true, anchorClosed: false }

    const outcome = await driver.runResponseBufferedSink(upstream(framesClean(completeFrames("anchor-callback"))), env, makeArraySink().sink, {
      ...makeStopTracker(),
      retryCap: 1,
      anchor,
      anchorState,
      ...(callback === "remap" && {
        wireAllocationPort: {
          wireState: { allocator: { anchorsOpened: () => 1 } },
          closeOpenAnchor: async () => ({ ok: true, value: "none" }),
        } as unknown as RunBufferedOpts["wireAllocationPort"],
      }),
    } as RunBufferedOpts)

    expect(outcome).toMatchObject({ kind: "stream-error", source: "codec-render", error: callbackError })
    expect(sendCount()).toBe(0)
  })

  test.each([
    ["commit boundary", "commitBoundaries"],
    ["terminal predicate", "sawMessageStop"],
  ])("buffered control callback failure (%s) is codec-render rather than transport", async (_name, callback) => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    const callbackError = new Error(`network-shaped ${callback} failure`)
    const { driver, sendCount } = makeDriver([upstream(framesClean(completeFrames("must-not-recover")))])
    const opts: RunBufferedOpts = {
      ...makeStopTracker(),
      retryCap: 1,
      ...(callback === "commitBoundaries" && {
        commitBoundaries() {
          throw callbackError
        },
      }),
      ...(callback === "sawMessageStop" && {
        sawMessageStop() {
          throw callbackError
        },
      }),
    }

    const outcome = await driver.runResponseBufferedSink(upstream(framesClean(completeFrames("callback-failure"))), env, makeArraySink().sink, opts)

    expect(outcome).toMatchObject({ kind: "stream-error", source: "codec-render", error: callbackError })
    expect(sendCount()).toBe(0)
  })

  test("buffer sink write rejection remains downstream-sink after codec callbacks", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    const sinkError = new Error("network-shaped sink failure")
    const { driver, sendCount } = makeDriver([upstream(framesClean(completeFrames("must-not-recover")))])
    const sink = { write: async () => Promise.reject(sinkError) }

    const outcome = await driver.runResponseBufferedSink(upstream(framesClean(completeFrames("sink-failure"))), env, sink, {
      ...makeStopTracker(),
      retryCap: 1,
    } as RunBufferedOpts)

    expect(outcome).toMatchObject({ kind: "stream-error", source: "downstream-sink", error: sinkError })
    expect(sendCount()).toBe(0)
  })

  test("transport-close RST → re-exchange; client receives ONLY the final complete generation", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({}) // simulate runRequest's first exchange (attempt 0)
    const first = upstream(framesThenThrow(partialFrames("msg_partial"), RST()))
    const { driver, sendCount } = makeDriver([upstream(framesClean(completeFrames("msg_complete")))])
    const { sink, frames } = makeArraySink()
    const tracker = makeStopTracker()

    const outcome = await driver.runResponseBufferedSink(first, env, sink, { ...tracker, retryCap: 1 } as RunBufferedOpts)

    expect(outcome.kind).toBe("complete")
    // The client gets the COMPLETE generation's frames (NO partial-attempt frames, NO [DONE]).
    expect(sinkTypes(frames)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"])
    // The partial attempt's message_start (msg_partial) never reached the client.
    expect(frames.some((fr) => (fr.data ?? "").includes("msg_partial"))).toBe(false)
    expect(frames.some((fr) => (fr.data ?? "").includes("msg_complete"))).toBe(true)
    // Exactly one re-exchange happened.
    expect(sendCount()).toBe(1)
    // D1: two attempts. The FAILED attempt keeps its OWN upstream-original sseEvents; the
    // SUCCESSFUL (final) attempt's frames live ONLY at the top-level slot (no per-attempt dup —
    // mirrors extractStagePayloads' finalIdx skip), so its per-attempt slot stays unset.
    const attempts = env.ctx.attempts
    expect(attempts).toHaveLength(2)
    expect(JSON.stringify(attempts[0].sseEvents)).toContain("msg_partial")
    expect(attempts[1].sseEvents).toBeUndefined()
  })

  test("H2 (terminal upstream `error` frame, clean drain WITHOUT message_stop) commits — NOT retried as truncation", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // A clean drain whose terminal frame is an upstream `error` event (e.g. overload), NO message_stop.
    const h2Frames: Array<UpstreamFrame> = [
      f("message_start", { message: { id: "msg_h2" } }),
      f("error", { error: { type: "overloaded_error", message: "overloaded" } }),
    ]
    const first = upstream(framesClean(h2Frames))
    // A would-be retry upstream exists; it must NOT be consumed (H2 is terminal, not a truncation).
    const { driver, sendCount } = makeDriver([upstream(framesClean(completeFrames("msg_should_not_run")))])
    const { sink, frames } = makeArraySink()
    let sawErr = false
    const tracker: Pick<RunBufferedOpts, "onUpstreamFrame" | "onAttemptReset" | "sawMessageStop" | "sawUpstreamError"> = {
      onUpstreamFrame: (frame: UpstreamFrame) => {
        try {
          if ((JSON.parse(frame.data ?? "{}") as { type?: string }).type === "error") sawErr = true
        } catch {
          /* ignore */
        }
      },
      onAttemptReset: () => {
        sawErr = false
      },
      sawMessageStop: () => false,
      sawUpstreamError: () => sawErr,
    }

    const outcome = await driver.runResponseBufferedSink(first, env, sink, { ...tracker, retryCap: 3 } as RunBufferedOpts)

    // H2 commits the buffer (the handler then fails via acc.streamError) — it is NOT retried.
    expect(outcome.kind).toBe("complete")
    expect(sendCount()).toBe(0) // no re-exchange — the retry upstream was never consumed
    // The buffered upstream error frame reached the client (mirrors the live path).
    expect(sinkTypes(frames)).toEqual(["message_start", "error"])
  })

  test("buffer cap exceeded → retreat to LIVE forwarding, NO retry, full generation delivered", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // A tiny cap (30 bytes) is exceeded within the first frame or two → retreat to live.
    const first = upstream(framesClean(completeFrames("msg_big")))
    const { driver, sendCount } = makeDriver([upstream(framesClean(completeFrames("msg_retry")))])
    const { sink, frames } = makeArraySink()
    const tracker = makeStopTracker()
    let retreated = false

    const outcome = await driver.runResponseBufferedSink(first, env, sink, {
      ...tracker,
      retryCap: 3,
      bufferCapBytes: 30,
      onRetreat: () => {
        retreated = true
      },
    } as RunBufferedOpts)

    expect(retreated).toBe(true) // the cap was exceeded
    expect(outcome.kind).toBe("complete")
    expect(sendCount()).toBe(0) // retreat forfeits retry — the retry upstream is never consumed
    // The WHOLE generation reached the client (retreat flushes the buffered prefix + writes the rest live).
    expect(sinkTypes(frames)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"])
  })

  test("retreated live sink rejection is downstream-sink", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    const first = upstream(framesClean(completeFrames("msg_retreat_write")))
    const { driver, sendCount } = makeDriver([upstream(framesClean(completeFrames("must-not-recover")))])
    const { sink } = makeArraySink({ rejectAtFrame: 1 })

    const outcome = await driver.runResponseBufferedSink(first, env, sink, {
      ...makeStopTracker(),
      retryCap: 1,
      bufferCapBytes: 30,
    } as RunBufferedOpts)

    expect(outcome).toMatchObject({ kind: "stream-error", source: "downstream-sink" })
    expect(sendCount()).toBe(0)
  })

  test("buffer cap exceeded THEN the stream RSTs → stream-error, NO retry (frames already forwarded)", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // Retreat early (cap 30), then the upstream RSTs — once retreated, the partial is on the wire,
    // so it canNOT be retried (mirrors the live path: a post-forward RST fails).
    const first = upstream(framesThenThrow(completeFrames("msg_partial").slice(0, 3), RST()))
    const { driver, sendCount } = makeDriver([upstream(framesClean(completeFrames("msg_retry")))])
    const { sink, frames } = makeArraySink()
    const tracker = makeStopTracker()

    const outcome = await driver.runResponseBufferedSink(first, env, sink, { ...tracker, retryCap: 3, bufferCapBytes: 30 } as RunBufferedOpts)

    expect(outcome.kind).toBe("stream-error")
    expect(sendCount()).toBe(0) // retreat already forfeited retry
    // The frames forwarded before the RST stay on the wire (live, can't unsend).
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.some((fr) => (fr.data ?? "").includes("msg_partial"))).toBe(true)
  })

  test("onBufferedResolve fires once with the terminal outcome + retry count", async () => {
    // (a) success after 1 retry.
    {
      const env = makeEnv()
      env.ctx.beginAttempt({})
      const first = upstream(framesThenThrow(partialFrames("p"), RST()))
      const { driver } = makeDriver([upstream(framesClean(completeFrames("ok")))])
      const { sink } = makeArraySink()
      const calls: Array<{ outcome: string; retries: number }> = []
      await driver.runResponseBufferedSink(first, env, sink, {
        ...makeStopTracker(),
        retryCap: 3,
        onBufferedResolve: (outcome, retries) => calls.push({ outcome, retries }),
      } as RunBufferedOpts)
      expect(calls).toEqual([{ outcome: "success", retries: 1 }])
    }
    // (b) exhausted after cap retries.
    {
      const env = makeEnv()
      env.ctx.beginAttempt({})
      const first = upstream(framesThenThrow(partialFrames("p1"), RST()))
      const { driver } = makeDriver([upstream(framesThenThrow(partialFrames("p2"), RST())), upstream(framesThenThrow(partialFrames("p3"), RST()))])
      const { sink } = makeArraySink()
      const calls: Array<{ outcome: string; retries: number }> = []
      await driver.runResponseBufferedSink(first, env, sink, {
        ...makeStopTracker(),
        retryCap: 2,
        onBufferedResolve: (outcome, retries) => calls.push({ outcome, retries }),
      } as RunBufferedOpts)
      expect(calls).toEqual([{ outcome: "exhausted", retries: 2 }])
    }
    // (c) retreated (buffer cap).
    {
      const env = makeEnv()
      env.ctx.beginAttempt({})
      const first = upstream(framesClean(completeFrames("big")))
      const { driver } = makeDriver([])
      const { sink } = makeArraySink()
      const calls: Array<{ outcome: string; retries: number }> = []
      await driver.runResponseBufferedSink(first, env, sink, {
        ...makeStopTracker(),
        retryCap: 3,
        bufferCapBytes: 30,
        onBufferedResolve: (outcome, retries) => calls.push({ outcome, retries }),
      } as RunBufferedOpts)
      expect(calls).toEqual([{ outcome: "retreated", retries: 0 }])
    }
  })

  test("truncation (clean drain WITHOUT message_stop) is retryable, not a false commit", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // First attempt drains cleanly but has NO message_stop (Bun clean-RST shape).
    const first = upstream(framesClean(partialFrames("msg_trunc")))
    const { driver } = makeDriver([upstream(framesClean(completeFrames("msg_ok")))])
    const { sink, frames } = makeArraySink()
    const tracker = makeStopTracker()

    const outcome = await driver.runResponseBufferedSink(first, env, sink, { ...tracker, retryCap: 1 } as RunBufferedOpts)

    expect(outcome.kind).toBe("complete")
    expect(sinkTypes(frames)).toContain("message_stop")
    expect(frames.some((fr) => (fr.data ?? "").includes("msg_trunc"))).toBe(false)
  })

  test("retries exhausted → stream-error, client got nothing committed", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    const first = upstream(framesThenThrow(partialFrames("p1"), RST()))
    // every retry also RSTs
    const { driver } = makeDriver([upstream(framesThenThrow(partialFrames("p2"), RST())), upstream(framesThenThrow(partialFrames("p3"), RST()))])
    const { sink, frames } = makeArraySink()
    const tracker = makeStopTracker()

    const outcome = await driver.runResponseBufferedSink(first, env, sink, { ...tracker, retryCap: 1 } as RunBufferedOpts)

    expect(outcome.kind).toBe("stream-error")
    // Nothing committed to the client (buffered path never forwards a failed generation).
    expect(frames).toHaveLength(0)
  })

  test("retryCap 0 → no retry; a transport-close surfaces immediately as stream-error", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    const first = upstream(framesThenThrow(partialFrames("x"), RST()))
    const { driver, sendCount } = makeDriver([])
    const { sink, frames } = makeArraySink()
    const tracker = makeStopTracker()

    const outcome = await driver.runResponseBufferedSink(first, env, sink, { ...tracker, retryCap: 0 } as RunBufferedOpts)

    expect(outcome.kind).toBe("stream-error")
    expect(sendCount()).toBe(0) // no re-exchange
    expect(frames).toHaveLength(0)
  })

  test("client disconnect mid-commit-flush → stream-error (a ResponseOutcome, never a raw throw)", async () => {
    const env = makeEnv()
    env.ctx.beginAttempt({})
    // A complete first attempt → commit path. The sink rejects on the 3rd flush write
    // (client gone mid-flush). The buffered sink must MAP it to an outcome, not throw out.
    const first = upstream(framesClean(completeFrames("msg_ok")))
    const { driver } = makeDriver([])
    const { sink, frames } = makeArraySink({ rejectAtFrame: 2 })
    const tracker = makeStopTracker()
    const resolves: Array<{ outcome: string; retries: number }> = []

    const outcome = await driver.runResponseBufferedSink(first, env, sink, {
      ...tracker,
      retryCap: 1,
      onBufferedResolve: (o, r) => resolves.push({ outcome: o, retries: r }),
    } as RunBufferedOpts)

    expect(outcome.kind).toBe("stream-error") // not a thrown rejection
    expect(frames).toHaveLength(2) // the two writes that landed before the reject
    // M1: the generation was COMPLETE (message_stop drained) — the mid-flush failure is a transport
    // delivery issue, counted as `success` so the hit-rate denominator isn't a blind spot.
    expect(resolves).toEqual([{ outcome: "success", retries: 0 }])
  })
})

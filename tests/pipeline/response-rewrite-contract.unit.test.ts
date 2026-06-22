/**
 * Stage A Task3 — response-rewrite registry CONTRACT (A1 pre-step invariants).
 *
 * Phase 4 atomically migrates four Anthropic response rewrites (recover-tool-call /
 * thinking-signature-compat / tool-input-decode / server-tool-filter) into
 * `BUILTIN_RESPONSE_REWRITES`, where the order they used to get from handwritten closure
 * nesting (streaming-pump.ts:195-228) becomes the `order` field + per-rewrite
 * `createState()`. This suite locks the implicit contract Phase 4 relies on, using
 * mock rewrites only — NO production rewrite is migrated here.
 *
 * Invariants locked (§4.0.3 / §4.A1):
 *   - single buffer: buffered frames flush at stream end in input order.
 *   - double-buffer cascade: an earlier buffer's flushed frames thread the LATER
 *     rewrites — including a later buffering rewrite, which buffers them and releases
 *     them at ITS flush turn (= recover.flush → decode.transform → decode.flush,
 *     handler-v4.ts:655-663). Frames released by rewrite[i] precede rewrite[j>i]'s.
 *   - index densify: a filter that suppresses a block + remaps later indices is
 *     threaded faithfully — content_block_start/delta/stop all remap consistently.
 *   - exception path (Phase 1): a mid-stream throw still drains EVERY buffer in
 *     ascending order via the finally `flushChain`, before the error re-propagates.
 *   - break path (Phase 4 trap): a consumer that `break`s on a passed-through sentinel
 *     (the production [DONE] shape) does NOT receive finally-flushed frames — IteratorClose
 *     discards them — whereas a draining consumer does. Phase 4 must keep a pre-break flush.
 *   - FrameAction mapping: emit{[]} drops, emit{[f,…]} forwards all, suppress drops
 *     (never flushed), buffer holds then flushes (and buffer WITHOUT a flush hook silently
 *     drops) — the regulation Phase 4 adapts the factory `processEvent` (Array<frame>) /
 *     `rewriteEvent` (string|null) outputs to.
 *   - RESPONSE_REWRITE_ORDER: the recover < decode < filter hard-ordering invariant.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestContext } from "~/lib/context/request"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  FrameAction,
  ResponseRewrite,
  RewriteState,
} from "~/lib/pipeline/rewrite-registry"
import type {
  //
  ClientFrame,
  FormatCodec,
  Transport,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

import {
  //
  createPipelineDriver,
  type DriverDeps,
} from "~/lib/pipeline/driver"
import { RESPONSE_REWRITE_ORDER } from "~/lib/pipeline/rewrite-registry"

// ── minimal harness (mirrors driver.unit.test.ts) ───────────────────────────

function makeCtx(): RequestContext {
  return { setSseEvents: () => undefined } as unknown as RequestContext
}

function makeEnv(): RequestEnvelope {
  const env = {
    clientFormat: "openai-cc",
    targetEndpoint: "/chat/completions",
    model: {},
    stream: true,
    body: {},
    view: {},
    prepareHints: {},
    ctx: makeCtx(),
    with(patch: Partial<RequestEnvelope>): RequestEnvelope {
      return { ...this, ...patch } as unknown as RequestEnvelope
    },
  }
  return env as unknown as RequestEnvelope
}

function makeCodec(): FormatCodec {
  return {
    format: "openai-cc",
    parse: () => makeEnv(),
    decideRoute: () => ({ kind: "passthrough", endpoint: "/chat/completions" }),
    translateOut: (env: RequestEnvelope) => env,
    prepareWire: () => ({ url: "u", headers: new Headers(), body: {}, stream: true }),
    renderResponse: (frame: UpstreamFrame) => frame, // identity → mock frames pass straight through
    renderResponseNonStreaming: (upstream: unknown) => upstream,
    formatError: () => ({ event: "error", data: "{}" }),
    createResponseAccumulator: () => ({ model: "", inputTokens: 0, outputTokens: 0, rawContent: "" }),
  } as unknown as FormatCodec
}

async function* gen<T>(items: Array<T>): AsyncIterable<T> {
  for (const i of items) yield i
}

async function* genThenThrow(items: Array<UpstreamFrame>, err: Error): AsyncIterable<UpstreamFrame> {
  for (const i of items) yield i
  throw err
}

function streamOf(frames: AsyncIterable<UpstreamFrame>): UpstreamStream {
  return { frames, headers: new Headers() } as unknown as UpstreamStream
}

const transport: Transport = { send: async () => streamOf(gen([])) }
const BASE: Omit<DriverDeps, "codec" | "transport"> = { strategies: [], maxRetries: 3, maxLearningRetries: 32 }

function driverWith(responseRewrites: ReadonlyArray<ResponseRewrite>) {
  return createPipelineDriver({ ...BASE, codec: makeCodec(), transport, responseRewrites })
}

async function collect(it: AsyncIterable<ClientFrame>): Promise<Array<string>> {
  const out: Array<string> = []
  for await (const f of it) out.push(f.data ?? "")
  return out
}

// ── mock rewrite builders ───────────────────────────────────────────────────

interface BufState extends RewriteState {
  buf: Array<string>
}

/** Buffers every frame; flush releases each verbatim, tagged `${tag}:<data>` (tag="" = verbatim). */
function mkBuffer(name: string, order: number, tag = ""): ResponseRewrite {
  return {
    name,
    order,
    appliesTo: () => true,
    createState: (): BufState => ({ buf: [] }),
    transform: (frame, state): FrameAction => {
      ;(state as BufState).buf.push(frame.data ?? "")
      return { kind: "buffer" }
    },
    flush: (state): Array<UpstreamFrame> => (state as BufState).buf.map((d) => ({ data: tag ? `${tag}:${d}` : d })),
  }
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("response-rewrite contract — buffer/flush determinism", () => {
  test("single buffer: N frames buffered then flushed in input order", async () => {
    const out = await collect(driverWith([mkBuffer("buf", 100)]).runResponse(streamOf(gen([{ data: "a" }, { data: "b" }, { data: "c" }])), makeEnv()))
    expect(out).toEqual(["a", "b", "c"])
  })

  test("double-buffer cascade: earlier buffer's flush threads the later buffer, released at the later flush", async () => {
    // r1(100) buffers everything; its flush emits `r1:<d>`. r2(200) buffers everything
    // (incl. r1's flushed frames during the cascade); its flush emits `r2:<d>`.
    // Mirrors recover.flush → decode.transform(buffer) → decode.flush.
    const out = await collect(
      driverWith([mkBuffer("r1", 100, "r1"), mkBuffer("r2", 200, "r2")]).runResponse(streamOf(gen([{ data: "x" }, { data: "y" }])), makeEnv()),
    )
    expect(out).toEqual(["r2:r1:x", "r2:r1:y"])
  })

  test("flush order is ascending: rewrite[i] releases before rewrite[j>i] (here r2 passes r1's flush straight through)", async () => {
    // r2(200) here is a passthrough (emit), so r1's flushed frames surface at r1's
    // flush turn (i=0); a frame r2 holds of its own would surface at i=1.
    const passEmit: ResponseRewrite = {
      name: "pass",
      order: 200,
      appliesTo: () => true,
      transform: (frame): FrameAction => ({ kind: "emit", frames: [{ data: `p:${frame.data}` }] }),
    }
    const out = await collect(driverWith([mkBuffer("r1", 100, "r1"), passEmit]).runResponse(streamOf(gen([{ data: "x" }])), makeEnv()))
    expect(out).toEqual(["p:r1:x"])
  })

  test("registration order is by `order`, not array order (assembleResponseRewrites sorts)", async () => {
    // Pass the rewrites in reverse array order; the cascade must still run 100 → 200.
    const out = await collect(driverWith([mkBuffer("r2", 200, "r2"), mkBuffer("r1", 100, "r1")]).runResponse(streamOf(gen([{ data: "x" }])), makeEnv()))
    expect(out).toEqual(["r2:r1:x"])
  })
})

describe("response-rewrite contract — index densify (suppress + remap)", () => {
  interface FiltState extends RewriteState {
    filtered: Set<number>
    map: Map<number, number>
    next: number
  }
  // A mock server-tool-filter: suppresses a `server:true` content_block_start (and the
  // matching delta/stop by index), and densifies surviving block indices.
  const filter: ResponseRewrite = {
    name: "filter",
    order: 300,
    appliesTo: () => true,
    createState: (): FiltState => ({ filtered: new Set(), map: new Map(), next: 0 }),
    transform: (frame, state): FrameAction => {
      const st = state as FiltState
      const obj = JSON.parse(frame.data ?? "{}") as { type: string; index: number; server?: boolean }
      if (obj.type === "content_block_start" && obj.server) {
        st.filtered.add(obj.index)
        return { kind: "suppress" }
      }
      if (st.filtered.has(obj.index)) return { kind: "suppress" }
      let ci = st.map.get(obj.index)
      if (ci === undefined) {
        ci = st.next++
        st.map.set(obj.index, ci)
      }
      return { kind: "emit", frames: [{ data: JSON.stringify({ ...obj, index: ci }) }] }
    },
  }

  test("suppressing the middle block densifies later indices consistently across start/delta/stop", async () => {
    const f = (type: string, index: number, server = false): UpstreamFrame => ({ data: JSON.stringify(server ? { type, index, server } : { type, index }) })
    const frames = [
      f("content_block_start", 0),
      f("content_block_delta", 0),
      f("content_block_stop", 0),
      f("content_block_start", 1, true), // server tool → suppressed
      f("content_block_delta", 1),
      f("content_block_stop", 1),
      f("content_block_start", 2), // densified 2 → 1
      f("content_block_delta", 2),
      f("content_block_stop", 2),
    ]
    const out = await collect(driverWith([filter]).runResponse(streamOf(gen(frames)), makeEnv()))
    const parsed = out.map((d) => JSON.parse(d) as { type: string; index: number })
    expect(parsed).toEqual([
      { type: "content_block_start", index: 0 },
      { type: "content_block_delta", index: 0 },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1 },
      { type: "content_block_delta", index: 1 },
      { type: "content_block_stop", index: 1 },
    ])
    expect(out.some((d) => d.includes("server"))).toBe(false)
  })
})

describe("response-rewrite contract — exception path drains every buffer (Phase 1 finally)", () => {
  test("mid-stream throw: finally flushChain drains BOTH buffers in ascending order before the error", async () => {
    const upstream = streamOf(genThenThrow([{ data: "a" }, { data: "b" }], new Error("boom")))
    const it = driverWith([mkBuffer("r1", 100, "r1"), mkBuffer("r2", 200, "r2")]).runResponse(upstream, makeEnv())
    const collected: Array<string> = []
    let caught: unknown
    try {
      for await (const f of it) collected.push(f.data ?? "")
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe("boom")
    // Both buffers drained, cascaded (r1.flush → r2.transform/buffer → r2.flush), in order.
    expect(collected).toEqual(["r2:r1:a", "r2:r1:b"])
  })
})

describe("response-rewrite contract — FrameAction mapping (Phase 4 factory-adapter regulation)", () => {
  function emitRewrite(frames: (d: string) => Array<UpstreamFrame>): ResponseRewrite {
    return { name: "emit", order: 100, appliesTo: () => true, transform: (frame): FrameAction => ({ kind: "emit", frames: frames(frame.data ?? "") }) }
  }

  test("emit{frames:[]} drops the frame (zero-frame emit)", async () => {
    const out = await collect(driverWith([emitRewrite(() => [])]).runResponse(streamOf(gen([{ data: "a" }, { data: "b" }])), makeEnv()))
    expect(out).toEqual([])
  })

  test("emit{frames:[f1,f2]} forwards every emitted frame in order", async () => {
    const out = await collect(driverWith([emitRewrite((d) => [{ data: `${d}1` }, { data: `${d}2` }])]).runResponse(streamOf(gen([{ data: "a" }])), makeEnv()))
    expect(out).toEqual(["a1", "a2"])
  })

  test("suppress drops and is NEVER flushed (no flush hook)", async () => {
    const suppress: ResponseRewrite = { name: "drop", order: 100, appliesTo: () => true, transform: (): FrameAction => ({ kind: "suppress" }) }
    const out = await collect(driverWith([suppress]).runResponse(streamOf(gen([{ data: "a" }, { data: "b" }])), makeEnv()))
    expect(out).toEqual([])
  })

  test("buffer with NO flush hook silently drops held frames (buffer REQUIRES a flush — Phase 4 footgun)", async () => {
    // A rewrite that returns `buffer` but omits `flush` accumulates nothing it can
    // release: `flushChain` reads `rewrites[i].flush?.(…) ?? []` (driver.ts), so the
    // held frames are lost. Phase 4 wrappers for recover/decode MUST supply `flush`.
    const bufferNoFlush: ResponseRewrite = { name: "buffer-no-flush", order: 100, appliesTo: () => true, transform: (): FrameAction => ({ kind: "buffer" }) }
    const out = await collect(driverWith([bufferNoFlush]).runResponse(streamOf(gen([{ data: "a" }, { data: "b" }])), makeEnv()))
    expect(out).toEqual([])
  })
})

describe("response-rewrite contract — break-path flush is NOT delivered (Phase 4 trap)", () => {
  // A rewrite that passes a sentinel straight through but buffers content frames,
  // releasing them only at stream-end flush — models decode/recover holding a
  // tool_use across the [DONE] the Anthropic pump breaks on.
  function partialBuffer(sentinel: string): ResponseRewrite {
    return {
      name: "partial-buffer",
      order: 100,
      appliesTo: () => true,
      createState: (): BufState => ({ buf: [] }),
      transform: (frame, state): FrameAction => {
        if (frame.data === sentinel) return { kind: "emit", frames: [frame] }
        ;(state as BufState).buf.push(frame.data ?? "")
        return { kind: "buffer" }
      },
      flush: (state): Array<UpstreamFrame> => (state as BufState).buf.map((d) => ({ data: `flushed:${d}` })),
    }
  }

  test("a DRAINING consumer receives the finally-flushed frames after the sentinel", async () => {
    const out = await collect(driverWith([partialBuffer("DONE")]).runResponse(streamOf(gen([{ data: "a" }, { data: "DONE" }])), makeEnv()))
    expect(out).toEqual(["DONE", "flushed:a"])
  })

  test("a BREAKING consumer (production [DONE] shape) does NOT receive finally-flushed frames — ECMAScript IteratorClose discards them", async () => {
    // The live Anthropic pump `break`s on [DONE] (handler-v4.ts:655); the resulting
    // generator `.return()` runs `runResponse`'s finally `flushChain`, but the frames it
    // yields are DISCARDED by the breaking consumer (proven in Phase 1, driver.ts
    // flushChain JSDoc). So Phase 4 MUST keep an explicit pre-break flush for the pump —
    // it CANNOT rely on the driver-finally to deliver stream-end buffers to the client.
    const it = driverWith([partialBuffer("DONE")]).runResponse(streamOf(gen([{ data: "a" }, { data: "DONE" }])), makeEnv())
    const collected: Array<string> = []
    for await (const f of it) {
      collected.push(f.data ?? "")
      if (f.data === "DONE") break // production-shape break — the buffered "a" is now stranded
    }
    expect(collected).toEqual(["DONE"]) // NOT ["DONE", "flushed:a"]
  })
})

describe("response-rewrite contract — RESPONSE_REWRITE_ORDER hard ordering invariant", () => {
  // Guards the constants themselves (recover < decode < filter — recover-tool-call/
  // stream.ts:40 + the densify-sees-final-blocks contract). Phase 4 additionally must
  // assert the four REAL rewrites register at exactly these orders (they don't exist yet).
  test("recover-tool-call < tool-input-decode < server-tool-filter", () => {
    expect(RESPONSE_REWRITE_ORDER.recoverToolCall).toBeLessThan(RESPONSE_REWRITE_ORDER.toolInputDecode)
    expect(RESPONSE_REWRITE_ORDER.toolInputDecode).toBeLessThan(RESPONSE_REWRITE_ORDER.serverToolFilter)
    // recover MUST precede the filter (the hardest contract — index/name remap depends on it).
    expect(RESPONSE_REWRITE_ORDER.recoverToolCall).toBeLessThan(RESPONSE_REWRITE_ORDER.serverToolFilter)
  })
})

/**
 * Shared minimal harness for the driver's L2 buffered-retry (`runResponseBufferedSink`).
 *
 * Wraps a frame array into a driver-consumable `{ deps, upstream, env, opts }` tuple so a
 * test can drive the free `runResponseBufferedSink(deps, upstream, env, sink, opts)` directly
 * with a mock codec/transport + a REAL RequestContext (exercises per-attempt sseEvents / the
 * attempt model). Extracted from the construction in `tests/pipeline/buffered-sink.unit.test.ts`
 * (identity anthropic codec, RST-capable transport, stop tracker) — NOT a new mock contract,
 * the same shapes the sibling already asserts against.
 */

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
import {
  //
  type DriverDeps,
} from "~/lib/pipeline/driver"

/** Yield a fixed frame list, then end cleanly (a clean drain — no throw). */
export async function* framesClean(items: Array<UpstreamFrame>): AsyncIterable<UpstreamFrame> {
  for (const i of items) yield i
}

/** Yield a fixed frame list, then throw (a transport-close RST). */
export async function* framesThenThrow(items: Array<UpstreamFrame>, error: Error): AsyncIterable<UpstreamFrame> {
  for (const i of items) yield i
  throw error
}

/** A transport-close RST error (Bun/undici shape → `classifyStreamError === "other"` → retryable). */
export const RST = (): Error => new Error("Stream closed with error code NGHTTP2_CANCEL")

/** Identity anthropic codec (Anthropic bypass-direct: renderResponse is identity). */
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

/** A transport whose `send` returns the given retry upstreams in sequence (empty = no retry expected). */
function makeTransport(retryUpstreams: Array<UpstreamStream>): { transport: Transport; sendCount: () => number } {
  let sendCount = 0
  const transport: Transport = {
    send: () => {
      const u = retryUpstreams[sendCount] ?? retryUpstreams.at(-1)
      sendCount++
      if (!u) throw new Error("makeBufferedHarness: retry attempted but no retry upstream provided")
      return Promise.resolve(u)
    },
  }
  return { transport, sendCount: () => sendCount }
}

export interface BufferedHarness {
  deps: DriverDeps
  upstream: UpstreamStream
  env: RequestEnvelope
  opts: RunBufferedOpts
  /** Number of transport re-exchanges consumed (retry count). */
  sendCount: () => number
}

/**
 * Build a buffered-retry harness from a first-attempt frame list.
 *
 * @param frames  the first attempt's upstream frames (rendered identity → client frames).
 * @param cfg.sawMessageStop  the baked default `opts.sawMessageStop` (tests may override in opts).
 * @param cfg.retryUpstreams  optional retry upstreams for re-exchange (default: none).
 */
export function makeBufferedHarness(frames: Array<ClientFrame>, cfg: { sawMessageStop: boolean; retryUpstreams?: Array<UpstreamStream> }): BufferedHarness {
  const env = makeEnv()
  env.ctx.beginAttempt({}) // simulate runRequest's first exchange (attempt 0)
  const upstream: UpstreamStream = { frames: framesClean(frames), headers: new Headers() }
  const { transport, sendCount } = makeTransport(cfg.retryUpstreams ?? [])
  const deps: DriverDeps = { codec: makeCodec(), transport, strategies: [], maxRetries: 3, maxLearningRetries: 32 }
  const opts: RunBufferedOpts = {
    sawMessageStop: () => cfg.sawMessageStop,
    onAttemptReset: () => {},
    retryCap: 1,
  }
  return { deps, upstream, env, opts, sendCount }
}

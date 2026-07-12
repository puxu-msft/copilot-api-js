/**
 * Shared mock codec/transport/ctx scaffolding for the hook-mount-point test suite
 * (Task 1.0-1.3 + 2.1-2.2, docs/plan/2026-07-12-upstream-hook-middleware). Mirrors the
 * conventions in `tests/pipeline/driver.unit.test.ts` (NOT re-exported from there — that
 * file is the byte-equivalence oracle itself and stays untouched) so the three new test
 * files (`driver-passthrough-golden`, `driver-hookpoints`, `driver-provenance`) don't
 * each hand-roll their own mock plumbing.
 */

import type { RequestContext } from "~/lib/context/request"
import type {
  //
  DriverDeps,
} from "~/lib/pipeline/driver"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  FormatCodec,
  PreparedRequest,
  RouteDecision,
  Transport,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

export interface CtxCalls {
  setSseEvents: Array<unknown>
}

export function makeCtx(): { ctx: RequestContext; calls: CtxCalls } {
  const calls: CtxCalls = { setSseEvents: [] }
  const ctx = {
    beginAttempt: () => {},
    transition: () => {},
    setAttemptError: () => {},
    recordAttemptFailure: () => {},
    setSseEvents: (e: unknown) => calls.setSseEvents.push(e),
    setHttpHeaders: () => {},
    setAttemptResponseHeaders: () => {},
    setRouteInfo: () => {},
    setAttemptEffectiveRequest: () => {},
    setAttemptWireRequest: () => {},
    addQueueWaitMs: () => {},
  } as unknown as RequestContext
  return { ctx, calls }
}

export function makeEnv(ctx: RequestContext, body: unknown = { v: 0 }): RequestEnvelope {
  const env = {
    clientFormat: "openai-cc",
    targetEndpoint: "/chat/completions",
    model: {},
    stream: true,
    body,
    view: {},
    prepareHints: {},
    ctx,
    with(patch: Partial<RequestEnvelope>): RequestEnvelope {
      return { ...this, ...patch } as unknown as RequestEnvelope
    },
  }
  return env as unknown as RequestEnvelope
}

export type MockCodec = FormatCodec & { decideRoute: (env: RequestEnvelope) => RouteDecision }

export function makeCodec(over: Partial<FormatCodec> & { env?: RequestEnvelope; decideRoute?: (env: RequestEnvelope) => RouteDecision } = {}): {
  codec: MockCodec
  spy: Record<string, number>
} {
  const spy: Record<string, number> = { parse: 0, decideRoute: 0, translateOut: 0, prepareWire: 0, renderResponse: 0, renderResponseNonStreaming: 0 }
  const base: FormatCodec = {
    format: "openai-cc",
    parse: (_raw) => {
      spy.parse++
      return over.env ?? makeEnv(makeCtx().ctx)
    },
    translateOut: over.translateOut ?? ((env) => (spy.translateOut++, env)),
    prepareWire: over.prepareWire ?? (() => (spy.prepareWire++, { url: "u", headers: new Headers(), body: {}, stream: true } as PreparedRequest)),
    renderResponse: over.renderResponse ?? ((frame) => (spy.renderResponse++, frame)),
    renderResponseNonStreaming: over.renderResponseNonStreaming ?? ((upstream) => (spy.renderResponseNonStreaming++, { rendered: upstream })),
    formatError: over.formatError ?? ((_err, _env) => ({ event: "error", data: "{}" }) as UpstreamFrame),
    createResponseAccumulator: over.createResponseAccumulator ?? (() => ({ model: "", inputTokens: 0, outputTokens: 0, rawContent: "" })),
  }
  const decide = over.decideRoute ?? (() => ({ kind: "passthrough", endpoint: "/chat/completions" }) as RouteDecision)
  const codec = Object.assign(base, { decideRoute: (env: RequestEnvelope) => (spy.decideRoute++, decide(env)) }) as MockCodec
  return { codec, spy }
}

export async function* gen<T>(items: Array<T>): AsyncIterable<T> {
  for (const i of items) yield i
}

export function makeTransport(send: Transport["send"]): Transport {
  return { send }
}

export function okStream(frames: Array<UpstreamFrame> = [], nonStream?: unknown): UpstreamStream {
  return { frames: gen(frames), ...(nonStream !== undefined && { nonStream }), headers: new Headers() }
}

export const BASE: Omit<DriverDeps, "codec" | "transport"> = { strategies: [], maxRetries: 3, maxLearningRetries: 32 }

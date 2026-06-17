/**
 * v4 pipeline — PipelineDriver (P2.1 skeleton).
 *
 * The data-flow driver: pushes a request through the seven stages (S1→S7),
 * publishing events / sampling raw data at the stage boundaries. Lifted+merged
 * from the current `executeRequestPipeline` retry loop and the handlers'
 * orchestration skeleton (docs/v4/01-architecture.md §1.3, 03-spec/envelope-driver.md §3).
 *
 * P2.1 builds the format-agnostic skeleton; it consumes a {@link FormatCodec} +
 * {@link Transport} + retry strategies + the rewrite registry as opaque deps, so
 * the unit tests drive it with a mock codec/transport. No format is wired here —
 * the codecs (P2.2–P2.6) and route switches (P2.3+) come later.
 */

import consola from "consola"

import { classifyError } from "~/lib/error"

import type { RequestEnvelope } from "./envelope"
import type {
  //
  ClientFrame,
  DriverRequestResult,
  FormatCodec,
  PipelineDriver,
  RawHttpRequest,
  RetryAction,
  RetryStrategy,
  Transport,
  UpstreamFrame,
  UpstreamStream,
} from "./types"

import {
  //
  assembleRequestRewrites,
  assembleResponseRewrites,
  REQUEST_REWRITES,
  RESPONSE_REWRITES,
  type RequestRewrite,
  type ResponseRewrite,
  type RewriteState,
} from "./rewrite-registry"

/**
 * Everything the driver needs to orchestrate one format. The route layer (P2.3+)
 * selects the codec by prefix and constructs a driver per request.
 */
export interface DriverDeps {
  codec: FormatCodec
  transport: Transport
  /**
   * Ordered retry strategies (first `canHandle` wins — 02 §1.2 order semantics).
   * Either a fixed array, or a per-request factory resolved with the parsed
   * envelope (S4 input) — strategies that need parse outputs (e.g. the model,
   * or the codec's truncation baseline) use the factory form.
   */
  strategies: ReadonlyArray<RetryStrategy> | ((env: RequestEnvelope) => ReadonlyArray<RetryStrategy>)
  /** Normal-budget retry cap (pipeline.ts default 3). */
  maxRetries: number
  /** Learning-budget retry cap (pipeline.ts MAX_LEARNING_RETRIES=32). */
  maxLearningRetries: number
  /** S3 request rewrites (codecs supply format rewrites; default = module registry). */
  requestRewrites?: ReadonlyArray<RequestRewrite>
  /** S5 response rewrites (codecs supply format rewrites; default = module registry). */
  responseRewrites?: ReadonlyArray<ResponseRewrite>
  /**
   * Post-gate per-retry meta sink (C0-② / RFC §11.2). The driver invokes it with
   * the `RetryAction.meta` of a retry **only after the budget gate accepts it**,
   * so a budget-rejected retry never emits phantom pipeline-info. The handler
   * routes the format-specific meta fields (CC `truncateResult`; Anthropic
   * `sanitization` / `strippedBetas` / `probedBetas` / `truncateResult`) to its
   * observability sinks. `env` is the post-retry env carrying that meta.
   */
  onMeta?: (meta: Record<string, unknown>, env: RequestEnvelope) => void
}

/** The driver with its non-streaming response variant (envelope-driver.md §3). */
export interface PipelineDriverWithNonStreaming extends PipelineDriver {
  /** S5→S6 non-streaming: render the whole upstream response back to the client. */
  runResponseNonStreaming(upstream: UpstreamStream, env: RequestEnvelope): unknown
}

export function createPipelineDriver(deps: DriverDeps): PipelineDriverWithNonStreaming {
  return {
    runRequest: (raw) => runRequest(deps, raw),
    runResponse: (upstream, env) => runResponse(deps, upstream, env),
    runResponseNonStreaming: (upstream, env) => deps.codec.renderResponseNonStreaming(upstream.nonStream, env),
  }
}

// ============================================================================
// Request side (S1→S4)
// ============================================================================

/** S1→S4: ingest → route/translate → rewrite-in → exchange (error-driven retry). */
async function runRequest(deps: DriverDeps, raw: RawHttpRequest): Promise<DriverRequestResult> {
  // S1 — Ingest: parse inbound → envelope (codec builds ctx + extracts body/model).
  const parsed = deps.codec.parse(raw)

  // S2 — Translate-in: decideRoute (passthrough / translate / reject) + translateOut.
  const decision = deps.codec.decideRoute(parsed)
  if (decision.kind === "reject") {
    // No dangling history entry — reject before committing the request (aligns
    // with current messages:165 rejecting before context creation). Carry the
    // raw reason; the route/codec shapes the per-format error envelope.
    return { ok: false, rejection: { status: decision.status, reason: decision.reason, format: parsed.clientFormat } }
  }
  const targetEndpoint = decision.kind === "passthrough" ? decision.endpoint : decision.to
  const routed = deps.codec.translateOut(parsed.with({ targetEndpoint }))

  // S3 — Rewrite-in: assemble + run the request-rewrite chain.
  const rewritten = runRewriteIn(deps, routed)

  // S4 — Exchange: error-driven retry loop (prepareWire → transport → strategy re-env).
  // Resolve the strategy factory now that the envelope (model + codec state) exists.
  const strategies = typeof deps.strategies === "function" ? deps.strategies(rewritten) : deps.strategies
  // C0-① (RFC §11.1): runExchange returns the POST-retry env (the final attempt's
  // env), not `rewritten` (pre-exchange). Consumers — e.g. the Anthropic pump
  // building the tool-call recoverer from env.body.tools, which deferred-tool-retry
  // mutates — must see what was actually sent on the successful attempt.
  const { upstream, env: settled } = await runExchange(deps, rewritten, strategies)
  return { ok: true, upstream, env: settled }
}

/** S3: assemble the request-rewrite chain and apply each in declared order. */
function runRewriteIn(deps: DriverDeps, env: RequestEnvelope): RequestEnvelope {
  let current = env
  for (const rewrite of assembleRequestRewrites(current, deps.requestRewrites ?? REQUEST_REWRITES)) {
    const result = rewrite.apply(current)
    current = result.env
    // P3.2 wires `request.rewrite_applied`{name, changed, stats} here.
  }
  return current
}

/**
 * S4: the error-driven retry loop (docs/v4/03-spec/retry-transport.md §2). Each
 * attempt re-derives the wire from env via `codec.prepareWire`; a failure runs
 * the first matching strategy, which returns a modified env, and the next turn
 * re-prepares from it. The adaptive rate-limiter (429) lives inside
 * `transport.send`, below this loop — it never bubbles up here.
 */
async function runExchange(
  deps: DriverDeps,
  env: RequestEnvelope,
  strategies: ReadonlyArray<RetryStrategy>,
): Promise<{ upstream: UpstreamStream; env: RequestEnvelope }> {
  let current = env
  let normalRetries = 0
  let learningRetries = 0
  let activeStrategy: RetryStrategy | undefined
  // The accepted retry's meta (post-gate), threaded to onMeta + onResolved (C0-②).
  let activeMeta: Record<string, unknown> | undefined

  for (;;) {
    const wire = deps.codec.prepareWire(current)
    current.ctx.beginAttempt({ ...(activeStrategy && { strategy: activeStrategy.name }) })
    // S4 per-attempt sampling (P2.3-S): the codec derives the history effective +
    // wire request descriptors from the prepared wire + env (format-specific). The
    // attempt record exists (beginAttempt above); record both tracks on it.
    const sample = deps.codec.sampleRequest?.(wire, current)
    if (sample) {
      current.ctx.setAttemptEffectiveRequest(sample.effective)
      current.ctx.setAttemptWireRequest(sample.wire)
    }
    current.ctx.transition("executing")
    try {
      const upstream = await deps.transport.send(wire, current)
      // onResolved threads the post-gate meta of the retry that produced this env
      // (C0-② / RFC §11.2) so the owning strategy commits its learning from it
      // (e.g. unsupported-beta fixates meta.probedBetas). undefined on first-attempt
      // success (no retry produced this env).
      await activeStrategy?.onResolved?.(current, activeMeta)
      // C0-① (RFC §11.1): return the POST-retry env (the final attempt's `current`),
      // not the caller's pre-exchange env — consumers read what was actually sent.
      return { upstream, env: current }
    } catch (error) {
      const apiError = classifyError(error)
      current.ctx.setAttemptError(apiError)

      const strategy = strategies.find((s) => s.canHandle(apiError))
      if (!strategy) throw error // no strategy → [FAIL]

      // A strategy that itself throws degrades to failing the request with the
      // ORIGINAL caught error (legacy parity — pipeline.ts:307-314 warns + breaks
      // + re-throws the original error rather than the strategy's own failure).
      let action: RetryAction
      try {
        action = await strategy.handle(apiError, current)
      } catch (strategyError) {
        consola.warn(
          `[Driver] Strategy "${strategy.name}" threw while handling the error:`,
          strategyError instanceof Error ? strategyError.message : strategyError,
        )
        throw error
      }
      // Abort → surface the ORIGINAL caught error (a proper Error/HTTPError with
      // stack), matching the legacy pipeline (which breaks the loop and re-throws
      // the original error, pipeline.ts:312). `apiError` (the classified form) is
      // already recorded via setAttemptError; `action.error` reserves a future
      // strategy-supplied override but is not surfaced here (the spec draft's
      // `throw action.error` would throw a non-Error ApiError, losing the stack).
      if (action.kind === "abort") throw error

      // Budget gate (normal vs learning) — after handle, mirroring pipeline.ts.
      const overBudget = action.learning ? learningRetries++ >= deps.maxLearningRetries : normalRetries++ >= deps.maxRetries
      if (overBudget) throw error

      current = action.env
      activeStrategy = strategy
      // Capture the accepted retry's meta post-gate (C0-② / RFC §11.2): a
      // budget-rejected retry threw above (over-budget → throw), so its meta never
      // reaches here. Route it to the handler's observability sink (only when
      // present) and remember it for this strategy's onResolved.
      activeMeta = action.meta
      if (action.meta) deps.onMeta?.(action.meta, current)
      current.ctx.recordAttemptFailure({
        willRetry: true,
        nextStrategy: strategy.name,
        ...(action.waitMs !== undefined && { waitMs: action.waitMs }),
        ...(action.learning && { learning: action.learning }),
      })
      // Count the retry backoff in queueWaitMs (legacy parity — pipeline.ts adds
      // action.waitMs to queueWaitMs in addition to the rate-limiter wait).
      if (action.waitMs) {
        current.ctx.addQueueWaitMs(action.waitMs)
        await delay(action.waitMs)
      }
    }
  }
}

// ============================================================================
// Response side (S5→S7)
// ============================================================================

/** S5→S7: rewrite-out (per-frame chain + flush) → renderResponse → yield. */
async function* runResponse(deps: DriverDeps, upstream: UpstreamStream, env: RequestEnvelope): AsyncIterable<ClientFrame> {
  // S5 — Rewrite-out: assemble the response-rewrite chain (per-request state).
  const rewrites = assembleResponseRewrites(env, deps.responseRewrites ?? RESPONSE_REWRITES)
  const states: Array<RewriteState> = rewrites.map((r) => r.createState?.() ?? {})

  for await (const frame of upstream.frames) {
    // S5: thread the upstream frame through the rewrite chain (emit/suppress/buffer).
    for (const rewritten of passThrough([frame], rewrites, states, 0)) {
      // S6 — Translate-out: render the (target-endpoint) frame to the client protocol.
      yield* renderFrames(deps, rewritten, env)
    }
  }

  // S5 flush: drain buffered frames at stream end, each threading the rewrites after it.
  for (const flushed of flushChain(rewrites, states)) {
    yield* renderFrames(deps, flushed, env)
  }
}

/** S6 + S7: render one upstream frame to client frame(s) and surface them. */
function* renderFrames(deps: DriverDeps, frame: UpstreamFrame, env: RequestEnvelope): Generator<ClientFrame> {
  const rendered = deps.codec.renderResponse(frame, env)
  const frames = Array.isArray(rendered) ? rendered : [rendered]
  for (const out of frames) {
    // P3.2 wires `request.forwarded_frame`{frame} sampling here.
    yield out
  }
}

/**
 * Thread frames through `rewrites[startIdx..]` in order. Each rewrite's
 * `transform` may emit 0+ frames (fed to the next rewrite), suppress, or buffer
 * (held in its own state, drained at flush). Returns the frames surviving the
 * whole sub-chain.
 */
function passThrough(
  frames: Array<UpstreamFrame>,
  rewrites: ReadonlyArray<ResponseRewrite>,
  states: Array<RewriteState>,
  startIdx: number,
): Array<UpstreamFrame> {
  let current = frames
  for (let i = startIdx; i < rewrites.length; i++) {
    const next: Array<UpstreamFrame> = []
    for (const frame of current) {
      const action = rewrites[i].transform(frame, states[i])
      if (action.kind === "emit") next.push(...action.frames)
      // suppress / buffer → emit nothing now (buffer is held in the rewrite's state)
    }
    current = next
  }
  return current
}

/**
 * Drain each rewrite's flush in order; flushed frames thread the rewrites after
 * it. Flush runs in ascending rewrite index, so a buffering rewrite's flushed
 * frames pass through every later rewrite (e.g. buffer→tag yields tagged frames).
 *
 * Assumption: at most ONE buffering rewrite per chain (the current real case is
 * tool-input-decode alone). With two buffering rewrites the relative order of a
 * later buffer's own held frames vs. an earlier buffer's flushed-then-emitted
 * frames is left undefined; lock the contract with a test before any chain with
 * multiple buffering rewrites lands (P2.6 — recorded in 05-progress P2.1-M2).
 */
function flushChain(rewrites: ReadonlyArray<ResponseRewrite>, states: Array<RewriteState>): Array<UpstreamFrame> {
  const out: Array<UpstreamFrame> = []
  for (let i = 0; i < rewrites.length; i++) {
    const flushed = rewrites[i].flush?.(states[i]) ?? []
    if (flushed.length > 0) out.push(...passThrough(flushed, rewrites, states, i + 1))
  }
  return out
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Candidate-local response state, rendering, classification, and terminal snapshot ownership. */

import type {
  //
  CandidateHandle,
  DispatchHandle,
} from "~/lib/context/model-operation-record"
import type {
  //
  DeliveryOutcome,
  DeliveryProtocolAdapter,
} from "~/lib/pipeline/delivery/protocol"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { ResponseRewrite } from "~/lib/pipeline/rewrite-registry"
import type {
  //
  CandidateResponseRenderer,
  ClientFrame,
  ResponseFinishResult,
  RunResponseOpts,
  UpstreamFrame,
} from "~/lib/pipeline/types"

import { createAnthropicDeliveryProtocolAdapter } from "~/lib/pipeline/delivery/adapters/anthropic"
import { createChatCompletionsDeliveryProtocolAdapter } from "~/lib/pipeline/delivery/adapters/chat-completions"
import { createGeminiDeliveryProtocolAdapter } from "~/lib/pipeline/delivery/adapters/gemini"
import { createResponsesDeliveryProtocolAdapter } from "~/lib/pipeline/delivery/adapters/responses"
import { createDeliveryGrammar } from "~/lib/pipeline/delivery/grammar"
import { readSyntheticKind } from "~/lib/pipeline/frame-origin"
import { getUpstreamHook } from "~/lib/pipeline/hooks/loader"
import {
  //
  asResponseCodecRenderError,
  createResponseProcessor,
  type ResponseProcessor,
} from "~/lib/pipeline/stream/response-processor"

import {
  //
  createCandidateBoundaryClassifier,
  type CandidateBoundaryClassifier,
} from "./boundary-classifier"

export type CandidateResponseFinish = ResponseFinishResult & Readonly<Record<string, unknown>>

/** The candidate-owned subset merged into every live or recovery response pump. */
export interface CandidateResponseSessionOptions extends RunResponseOpts {
  readonly sawMessageStop?: () => boolean
  readonly sawUpstreamError?: () => boolean
  /** A terminal upstream DECISION that carries no `message_stop`: a contentless refusal. */
  readonly sawContentlessRefusal?: () => boolean
  readonly commitBoundaries?: (frame: ClientFrame) => boolean
  readonly transformBufferedFlush?: (frames: ReadonlyArray<ClientFrame>, ctx: import("~/lib/pipeline/types").BufferedFlushContext) => ReadonlyArray<ClientFrame>
  readonly stopAfterFrame?: (frame: ClientFrame) => boolean
  readonly onBufferedResolve?: (outcome: import("~/lib/pipeline/types").ProtectStreamingOutcome, retries: number, meta: { vendor: string }) => void
}

export interface CandidateResponseSession<Snapshot = unknown> {
  readonly identity: symbol
  readonly candidate: CandidateHandle
  readonly dispatch: DispatchHandle
  readonly renderer: CandidateResponseRenderer
  readonly adapter: DeliveryProtocolAdapter
  readonly processor: ResponseProcessor
  readonly responseOpts: CandidateResponseSessionOptions
  readonly boundary: CandidateBoundaryClassifier
  readonly outcomes: ReadonlyArray<DeliveryOutcome>
  readonly finish: CandidateResponseFinish | undefined
  snapshot(): Snapshot
}

export interface CreateCandidateResponseSessionInput<State, Snapshot> {
  readonly candidate: CandidateHandle
  readonly dispatch: DispatchHandle
  readonly env: RequestEnvelope
  readonly responseRewrites: ReadonlyArray<ResponseRewrite>
  readonly renderer: CandidateResponseRenderer
  /** Explicit for Responses transport-mode selection; other formats may omit and use their sole mode. */
  readonly adapter?: DeliveryProtocolAdapter
  /** False only for response-only compatibility helpers whose synthetic handle is not registered in RequestContext. */
  readonly dispatchScopedCapture?: boolean
  readonly createState: () => State
  readonly onUpstreamFrame?: (state: State, frame: UpstreamFrame) => void
  readonly onRenderedFrame?: (state: State, frame: ClientFrame) => ClientFrame | undefined
  readonly finish?: (state: State, renderer: CandidateResponseRenderer, rendererFrames: ReadonlyArray<ClientFrame>) => CandidateResponseFinish
  readonly snapshot: (state: State, renderer: CandidateResponseRenderer, finish: CandidateResponseFinish | undefined) => Snapshot
  /** See {@link CandidateResponseSession.sawContentlessRefusal}. */
  readonly sawContentlessRefusal?: (state: State) => boolean
  readonly transformBufferedFlush?: (
    state: State,
    frames: ReadonlyArray<ClientFrame>,
    ctx: import("~/lib/pipeline/types").BufferedFlushContext,
  ) => ReadonlyArray<ClientFrame>
  readonly stopAfterFrame?: (state: State, frame: ClientFrame) => boolean
  readonly onBufferedResolve?: (
    state: State,
    outcome: import("~/lib/pipeline/types").ProtectStreamingOutcome,
    retries: number,
    meta: { vendor: string },
  ) => void
}

export type CandidateResponseSessionFactory = (input: {
  readonly candidate: CandidateHandle
  readonly dispatch: DispatchHandle
  readonly env: RequestEnvelope
  readonly responseRewrites: ReadonlyArray<ResponseRewrite>
  readonly renderer: CandidateResponseRenderer
}) => CandidateResponseSession

/** Build one response session. No sink, timer, or downstream-delivery capability enters this owner. */
export function createCandidateResponseSession<State, Snapshot>(
  input: CreateCandidateResponseSessionInput<State, Snapshot>,
): CandidateResponseSession<Snapshot> {
  const state = input.createState()
  const adapter = input.adapter ?? defaultAdapter(input.env)
  const boundary = createCandidateBoundaryClassifier()
  const grammar = createDeliveryGrammar({ mode: adapter.deliveryMode })
  const outcomes: Array<DeliveryOutcome> = []
  const completedBoundaryFrames = new WeakSet<ClientFrame>()
  let sawTerminal = false
  let sawFailure = false
  const identity = Symbol("candidateResponseSession")
  let sequence = 0
  const recordOutcome = (outcome: DeliveryOutcome, frame?: ClientFrame): void => {
    outcomes.push(outcome)
    if (outcome.kind === "complete-unit" && frame) completedBoundaryFrames.add(frame)
    if (outcome.kind === "response-terminal") {
      sawTerminal = true
      if (outcome.terminal.semantic === "failed") sawFailure = true
    }
  }
  let finish: CandidateResponseFinish | undefined
  let finishResolved: CandidateResponseFinish | undefined
  let terminalSnapshot: Snapshot | undefined
  const captureTerminalSnapshot = (): void => {
    if (terminalSnapshot !== undefined) return
    const snapshot = input.snapshot(state, input.renderer, finish)
    terminalSnapshot = snapshot !== null && typeof snapshot === "object" ? Object.freeze(snapshot) : snapshot
  }

  const consumeFrame = (frame: ClientFrame): void => {
    const syntheticKind = readSyntheticKind(frame)
    const envelope = {
      frame,
      sequence: sequence++,
      observedAtMonotonic: performance.now(),
      provenance:
        syntheticKind === undefined ?
          ({ kind: "candidate", candidateId: String(input.candidate), dispatchId: String(input.dispatch) } as const)
        : ({ kind: "synthetic", syntheticKind } as const),
    }
    let classified: ReturnType<DeliveryProtocolAdapter["classify"]>
    try {
      classified = adapter.classify({ frame })
    } catch (cause) {
      classified = {
        kind: "protocol-error",
        error: { semantic: "adapter-exception", detail: cause instanceof Error ? cause.message : String(cause), sourceFrame: frame, cause },
      }
    }
    const next = grammar.consume({ kind: "frame", classified })
    for (const outcome of next) {
      recordOutcome(outcome, frame)
      if (outcome.kind === "protocol-error" && isUpstreamFailure(outcome.error.semantic)) sawFailure = true
      boundary.observe(outcome, envelope)
    }
  }

  const postRender = (frame: ClientFrame): ClientFrame | undefined => {
    try {
      // The legacy mutating client.outbound hook belongs before classification and is therefore
      // candidate-local. P7-T2d still has to replace its delivery-side contract with observe-only.
      const hook = getUpstreamHook()?.client?.outbound
      const hooked = hook ? hook(frame, input.env) : frame
      if (hooked === undefined) return undefined
      const transformed = input.onRenderedFrame ? input.onRenderedFrame(state, hooked) : hooked
      if (transformed === undefined) return undefined
      if (transformed !== frame || readSyntheticKind(transformed) !== undefined) {
        const transform = { stage: "client-transform", transformId: "candidate:on-rendered-frame", forceDerived: true }
        if (typeof input.env.ctx.captureGenerationDispatchFrameTransform === "function") {
          input.env.ctx.captureGenerationDispatchFrameTransform(input.dispatch, frame, transformed, transform)
        } else {
          input.env.ctx.captureGenerationFrameTransform?.(frame, transformed, transform)
        }
      }
      consumeFrame(transformed)
      return transformed
    } catch (error) {
      throw asResponseCodecRenderError(error)
    }
  }

  const responseOpts: CandidateResponseSessionOptions = {
    ...(input.onUpstreamFrame && { onUpstreamFrame: (frame) => input.onUpstreamFrame?.(state, frame) }),
    onRenderedFrame: postRender,
    finishResponse: (rendererFrames) => {
      finish = input.finish?.(state, input.renderer, rendererFrames) ?? { kind: "complete", frames: rendererFrames }
      return finish
    },
    onFinishResolved: (result) => {
      finishResolved = result
      let classified: ReturnType<DeliveryProtocolAdapter["classifyFinish"]>
      try {
        classified = adapter.classifyFinish(result)
      } catch (cause) {
        classified = {
          kind: "terminal-failure",
          error: { semantic: "adapter-exception", detail: cause instanceof Error ? cause.message : String(cause), sourceFrame: null, cause },
        }
      }
      const next = grammar.consume({ kind: "finish", classified })
      for (const outcome of next) {
        recordOutcome(outcome)
        if (outcome.kind === "protocol-error" && isUpstreamFailure(outcome.error.semantic)) sawFailure = true
      }
    },
    // A natural `complete` finish is a terminal declaration for legacy direct Responses streams
    // whose emitted events predate output-item lifecycle framing. It is distinct from `truncated`,
    // so Chat's missing finish_reason remains retryable.
    sawMessageStop: () =>
      sawTerminal
      || finishResolved?.kind === "valid-terminal-without-boundary"
      || (input.env.clientFormat === "openai-responses" && finishResolved?.kind === "complete"),
    sawUpstreamError: () => sawFailure || finishResolved?.kind === "terminal-failure",
    ...(input.sawContentlessRefusal && { sawContentlessRefusal: () => input.sawContentlessRefusal?.(state) ?? false }),
    ...(adapter.deliveryMode === "unit" && { commitBoundaries: (frame: ClientFrame) => completedBoundaryFrames.has(frame) }),
    ...(input.transformBufferedFlush && { transformBufferedFlush: (frames, ctx) => input.transformBufferedFlush?.(state, frames, ctx) ?? frames }),
    ...(input.stopAfterFrame && { stopAfterFrame: (frame) => input.stopAfterFrame?.(state, frame) ?? false }),
    ...(input.onBufferedResolve && {
      onBufferedResolve: (outcome, retries, meta) => input.onBufferedResolve?.(state, outcome, retries, meta),
    }),
  }

  return {
    identity,
    candidate: input.candidate,
    dispatch: input.dispatch,
    renderer: input.renderer,
    adapter,
    processor: createResponseProcessor({
      env: input.env,
      ...(input.dispatchScopedCapture !== false && { dispatch: input.dispatch }),
      responseRewrites: input.responseRewrites,
      renderer: input.renderer,
      onRenderedFrame: postRender,
      onSettled: captureTerminalSnapshot,
    }),
    responseOpts,
    boundary,
    get outcomes() {
      return Object.freeze([...outcomes])
    },
    get finish() {
      return finish
    },
    snapshot() {
      // A consumer may close while yielding renderer finish frames (for example WS terminal early-stop),
      // before the processor can resume past its final yield. The presence of a finish verdict proves the
      // terminal boundary; cache on first read so that path still exposes one immutable terminal snapshot.
      if (terminalSnapshot === undefined && finish !== undefined) captureTerminalSnapshot()
      return terminalSnapshot ?? input.snapshot(state, input.renderer, finish)
    },
  }
}

/** Default candidate session for stateless/mock handlers and response-only helpers. */
function isUpstreamFailure(semantic: import("~/lib/pipeline/delivery/protocol").ClientProtocolError["semantic"]): boolean {
  return semantic === "terminal-failure" || semantic === "adapter-exception"
}

function defaultAdapter(env: RequestEnvelope): DeliveryProtocolAdapter {
  switch (env.clientFormat) {
    case "anthropic": {
      return createAnthropicDeliveryProtocolAdapter()
    }
    case "openai-cc": {
      return createChatCompletionsDeliveryProtocolAdapter()
    }
    case "gemini": {
      return createGeminiDeliveryProtocolAdapter()
    }
    case "openai-responses": {
      return createResponsesDeliveryProtocolAdapter({ transport: "http" })
    }
    default: {
      return assertNeverClientFormat(env.clientFormat)
    }
  }
}

function assertNeverClientFormat(value: never): never {
  throw new Error(`Unsupported client format: ${String(value)}`)
}

export function createDefaultCandidateResponseSession(input: {
  readonly candidate: CandidateHandle
  readonly dispatch: DispatchHandle
  readonly env: RequestEnvelope
  readonly responseRewrites: ReadonlyArray<ResponseRewrite>
  readonly renderer: CandidateResponseRenderer
}): CandidateResponseSession<void> {
  return createCandidateResponseSession({ ...input, dispatchScopedCapture: false, createState: () => undefined, snapshot: () => undefined })
}

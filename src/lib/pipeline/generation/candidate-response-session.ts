/** Candidate-local response state, rendering, classification, and terminal snapshot ownership. */

import type {
  //
  CandidateHandle,
  DispatchHandle,
} from "~/lib/context/model-operation-record"
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

import { readSyntheticKind } from "~/lib/pipeline/frame-origin"
import { getUpstreamHook } from "~/lib/pipeline/hooks/loader"
import {
  //
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
  readonly commitBoundaries?: (frame: ClientFrame) => boolean
  readonly stopAfterFrame?: (frame: ClientFrame) => boolean
  readonly onBufferedResolve?: (outcome: import("~/lib/pipeline/types").ProtectStreamingOutcome, retries: number, meta: { vendor: string }) => void
}

export interface CandidateResponseSession<Snapshot = unknown> {
  readonly identity: symbol
  readonly candidate: CandidateHandle
  readonly dispatch: DispatchHandle
  readonly renderer: CandidateResponseRenderer
  readonly processor: ResponseProcessor
  readonly responseOpts: CandidateResponseSessionOptions
  readonly boundary: CandidateBoundaryClassifier
  snapshot(): Snapshot
}

export interface CreateCandidateResponseSessionInput<State, Snapshot> {
  readonly candidate: CandidateHandle
  readonly dispatch: DispatchHandle
  readonly env: RequestEnvelope
  readonly responseRewrites: ReadonlyArray<ResponseRewrite>
  readonly renderer: CandidateResponseRenderer
  readonly createState: () => State
  readonly onUpstreamFrame?: (state: State, frame: UpstreamFrame) => void
  readonly onRenderedFrame?: (state: State, frame: ClientFrame) => ClientFrame | undefined
  readonly finish?: (state: State, renderer: CandidateResponseRenderer, rendererFrames: ReadonlyArray<ClientFrame>) => CandidateResponseFinish
  readonly snapshot: (state: State, renderer: CandidateResponseRenderer, finish: CandidateResponseFinish | undefined) => Snapshot
  readonly sawMessageStop?: (state: State) => boolean
  readonly sawUpstreamError?: (state: State) => boolean
  readonly commitBoundaries?: (state: State, frame: ClientFrame) => boolean
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
  const boundary = createCandidateBoundaryClassifier(input.env.clientFormat)
  const identity = Symbol("candidateResponseSession")
  let sequence = 0
  let finish: CandidateResponseFinish | undefined
  let terminalSnapshot: Snapshot | undefined
  const captureTerminalSnapshot = (): void => {
    if (terminalSnapshot !== undefined) return
    const snapshot = input.snapshot(state, input.renderer, finish)
    terminalSnapshot = snapshot !== null && typeof snapshot === "object" ? Object.freeze(snapshot) : snapshot
  }

  const postRender = (frame: ClientFrame): ClientFrame | undefined => {
    // The legacy mutating client.outbound hook belongs before classification and is therefore
    // candidate-local. P7-T2d still has to replace its delivery-side contract with observe-only.
    const hook = getUpstreamHook()?.client?.outbound
    const hooked = hook ? hook(frame, input.env) : frame
    if (hooked === undefined) return undefined
    const transformed = input.onRenderedFrame ? input.onRenderedFrame(state, hooked) : hooked
    if (transformed === undefined) return undefined
    const syntheticKind = readSyntheticKind(transformed)
    boundary.observe({
      frame: transformed,
      sequence: sequence++,
      observedAtMonotonic: performance.now(),
      provenance:
        syntheticKind === undefined ?
          { kind: "candidate", candidateId: String(input.candidate), dispatchId: String(input.dispatch) }
        : { kind: "synthetic", syntheticKind },
    })
    return transformed
  }

  const responseOpts: CandidateResponseSessionOptions = {
    ...(input.onUpstreamFrame && { onUpstreamFrame: (frame) => input.onUpstreamFrame?.(state, frame) }),
    onRenderedFrame: postRender,
    finishResponse: (rendererFrames) => {
      finish = input.finish?.(state, input.renderer, rendererFrames) ?? { kind: "complete", frames: rendererFrames }
      return finish
    },
    ...(input.sawMessageStop && { sawMessageStop: () => input.sawMessageStop?.(state) ?? false }),
    ...(input.sawUpstreamError && { sawUpstreamError: () => input.sawUpstreamError?.(state) ?? false }),
    ...(input.commitBoundaries && { commitBoundaries: (frame) => input.commitBoundaries?.(state, frame) ?? false }),
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
    processor: createResponseProcessor({
      env: input.env,
      responseRewrites: input.responseRewrites,
      renderer: input.renderer,
      onSettled: captureTerminalSnapshot,
    }),
    responseOpts,
    boundary,
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
export function createDefaultCandidateResponseSession(input: {
  readonly candidate: CandidateHandle
  readonly dispatch: DispatchHandle
  readonly env: RequestEnvelope
  readonly responseRewrites: ReadonlyArray<ResponseRewrite>
  readonly renderer: CandidateResponseRenderer
}): CandidateResponseSession<void> {
  return createCandidateResponseSession({ ...input, createState: () => undefined, snapshot: () => undefined })
}

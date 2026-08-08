/**
 * Branch-local streaming response processor.
 *
 * Owns one response rewrite-state set and the S4-original → S5 rewrite → S6 render
 * frame path. It is single-use: a retry/recovery/hedge candidate must construct a
 * fresh processor instead of reusing mutable rewrite or translator state.
 *
 * This extraction is behavior-preserving. Candidate boundary classification and
 * terminal `finish()` semantics land in the next task after every handler-side
 * translator flush has moved behind this owner.
 */

import type { DispatchHandle } from "~/lib/context/model-operation-record"
import type { SseEventRecord } from "~/lib/history"

import { readSyntheticKind } from "~/lib/pipeline/frame-origin"
import { getUpstreamHook } from "~/lib/pipeline/hooks/loader"
import {
  //
  readOrigin,
  tagFrameRewritten,
} from "~/lib/pipeline/hooks/origin"
import {
  //
  mapSemanticSseFrame,
  projectParsedSseFrame,
  semanticSseMessage,
} from "~/lib/transport/parsed-sse-frame"

import type { RequestEnvelope } from "../envelope"
import type {
  //
  ClientFrame,
  CandidateResponseRenderer,
  FormatCodec,
  RunResponseOpts,
  TransportUpstreamFrame,
  UpstreamStream,
} from "../types"

import {
  //
  isFirstUpstreamContent,
  isUpstreamContentFrame,
} from "../request-timing"
import {
  //
  assembleResponseRewrites,
  type FrameAction,
  type ResponseRewrite,
  type RewriteState,
} from "../rewrite-registry"

/** Construction input for one branch-local processor. */
export interface CreateResponseProcessorInput {
  readonly env: RequestEnvelope
  readonly dispatch?: DispatchHandle
  readonly responseRewrites: ReadonlyArray<ResponseRewrite>
  readonly renderer?: CandidateResponseRenderer
  /** Response-only test adapter; production candidates pass renderer. */
  readonly renderResponse?: FormatCodec["renderResponse"]
  /** The single post-render transformation/classification gate for every yielded client frame. */
  readonly onRenderedFrame?: (frame: ClientFrame) => ClientFrame | undefined
  readonly onSettled?: () => void
}

/** A single-use response processor with private rewrite/translator state. */
export interface ResponseProcessor {
  readonly identity: symbol
  stream(upstream: UpstreamStream, opts?: RunResponseOpts): AsyncIterable<ClientFrame>
}

/** Create a processor whose mutable state is isolated from every sibling candidate. */
export function createResponseProcessor(input: CreateResponseProcessorInput): ResponseProcessor {
  const { env } = input
  const renderer = input.renderer ?? (input.renderResponse ? { renderResponse: input.renderResponse, flushResponse: () => [] } : undefined)
  if (!renderer) throw new Error("[response-processor] candidate renderer is required")
  const rewrites = assembleResponseRewrites(env, input.responseRewrites)
  const states: Array<RewriteState> = rewrites.map((rewrite) => rewrite.createState?.(env) ?? {})
  const identity = Symbol("responseProcessor")
  let consumed = false

  return {
    identity,
    stream(upstream, opts) {
      if (consumed) throw new Error("[response-processor] processor already consumed")
      consumed = true
      // Candidate options contain the Task 3 classification gate. When an outer
      // caller supplies its own transformation, driver.ts composes it before this
      // gate; choosing the assembled option avoids classifying a frame twice.
      const postRender = opts?.onRenderedFrame ?? input.onRenderedFrame
      return processFrames({
        env,
        dispatch: input.dispatch,
        upstream,
        opts,
        rewrites,
        states,
        renderer,
        postRender,
        onSettled: input.onSettled,
      })
    },
  }
}

interface ProcessFramesInput {
  readonly env: RequestEnvelope
  readonly dispatch?: DispatchHandle
  readonly upstream: UpstreamStream
  readonly opts?: RunResponseOpts
  readonly rewrites: ReadonlyArray<ResponseRewrite>
  readonly states: Array<RewriteState>
  readonly renderer: CandidateResponseRenderer
  readonly postRender?: (frame: ClientFrame) => ClientFrame | undefined
  readonly onSettled?: () => void
}

async function* processFrames(input: ProcessFramesInput): AsyncIterable<ClientFrame> {
  const { env, dispatch, upstream, opts, rewrites, states, renderer, postRender } = input
  const emit = function* (frames: Iterable<ClientFrame>): Generator<ClientFrame> {
    for (const frame of frames) {
      const transformed = postRender ? postRender(frame) : frame
      if (transformed) yield transformed
    }
  }
  const upstreamSse: Array<SseEventRecord> = []
  const streamStartMs = Date.now()
  let frameIndex = 0
  const onRewriteAction = opts?.onRewriteAction
  const sampleAction = onRewriteAction ? (name: string, action: FrameAction) => onRewriteAction(name, frameIndex, action) : undefined
  const bufferedInputsByRewrite = new Map<string, Array<TransportUpstreamFrame>>()
  const captureRewrite = (name: string, frame: TransportUpstreamFrame, action: FrameAction): void => {
    const transformId = `rewrite-out:${name}`
    if (action.kind === "buffer") {
      const buffered = bufferedInputsByRewrite.get(name) ?? []
      buffered.push(frame)
      bufferedInputsByRewrite.set(name, buffered)
      if (dispatch && typeof env.ctx.captureGenerationDispatchFrameAction === "function")
        env.ctx.captureGenerationDispatchFrameAction(dispatch, [frame], [], { stage: "rewrite-out", transformId, action: "buffer" })
      else env.ctx.captureGenerationFrameAction?.([frame], [], { stage: "rewrite-out", transformId, action: "buffer" })
      return
    }
    const buffered = bufferedInputsByRewrite.get(name) ?? []
    bufferedInputsByRewrite.delete(name)
    const inputs = [...buffered, frame]
    const capture =
      dispatch && typeof env.ctx.captureGenerationDispatchFrameAction === "function" ?
        env.ctx.captureGenerationDispatchFrameAction.bind(env.ctx, dispatch)
      : env.ctx.captureGenerationFrameAction?.bind(env.ctx)
    capture?.(inputs, action.kind === "emit" ? action.frames : [], {
      stage: "rewrite-out",
      transformId,
      action: action.kind,
      forceDerived: action.kind === "emit" && action.frames.some((output) => output !== frame || readSyntheticKind(output) !== undefined),
    })
  }
  const captureFlush = (name: string, outputs: ReadonlyArray<TransportUpstreamFrame>): void => {
    const buffered = bufferedInputsByRewrite.get(name) ?? []
    bufferedInputsByRewrite.delete(name)
    const capture =
      dispatch && typeof env.ctx.captureGenerationDispatchFrameAction === "function" ?
        env.ctx.captureGenerationDispatchFrameAction.bind(env.ctx, dispatch)
      : env.ctx.captureGenerationFrameAction?.bind(env.ctx)
    capture?.(buffered, outputs, {
      stage: "rewrite-out",
      transformId: `rewrite-out:${name}`,
      action: "flush",
      forceDerived: outputs.length > 0,
    })
  }
  const origin = readOrigin(upstream)
  let naturalDrain = false

  try {
    for await (const frame of upstream.frames) {
      const semanticFrame = semanticSseMessage(frame)
      if (semanticFrame.data !== "[DONE]") {
        const upstreamRecord: SseEventRecord = {
          offsetMs: Date.now() - streamStartMs,
          type: semanticFrame.event ?? (semanticFrame.data ? "message" : "keepalive"),
          raw: semanticFrame.data ?? "",
          ...(origin && { synthetic: origin }),
        }
        upstreamSse.push(upstreamRecord)
        if (dispatch && typeof env.ctx.captureUpstreamGenerationDispatchFrame === "function") {
          env.ctx.captureUpstreamGenerationDispatchFrame(dispatch, frame, upstreamRecord)
          if (upstreamSse.length === 1) env.ctx.setGenerationDispatchSseEvents(dispatch, upstreamSse)
        } else {
          env.ctx.captureUpstreamGenerationFrame?.(frame, upstreamRecord)
          if (upstreamSse.length === 1) env.ctx.setSseEvents(upstreamSse)
        }
        const now = Date.now()
        const recordTiming = (kind: import("~/lib/context/types").AttemptTimingKind, mode: "once" | "latest") => {
          if (dispatch && typeof env.ctx.setGenerationDispatchTimingEpoch === "function") env.ctx.setGenerationDispatchTimingEpoch(dispatch, kind, now, mode)
          else env.ctx.setAttemptTimingEpoch?.(kind, now, mode)
        }
        if (semanticFrame.event === "message_start") recordTiming("upstreamMessageStartAt", "once")
        if (isFirstUpstreamContent(semanticFrame, env.targetEndpoint)) recordTiming("upstreamFirstTokenAt", "once")
        if (isUpstreamContentFrame(semanticFrame, env.targetEndpoint)) recordTiming("upstreamLastTokenAt", "latest")
        opts?.onUpstreamFrame?.(semanticFrame)
      }

      const hook = getUpstreamHook()
      let effectiveFrame: TransportUpstreamFrame | undefined = frame
      if (hook?.upstream?.inbound && semanticFrame.data !== "[DONE]") {
        const rewritten = hook.upstream.inbound(semanticFrame, env)
        if (rewritten === undefined) effectiveFrame = undefined
        else if (rewritten === semanticFrame) effectiveFrame = frame
        else effectiveFrame = mapSemanticSseFrame(frame, () => tagFrameRewritten(rewritten), "fresh")
        if (effectiveFrame === undefined) {
          if (dispatch && typeof env.ctx.captureGenerationDispatchFrameAction === "function")
            env.ctx.captureGenerationDispatchFrameAction(dispatch, [frame], [], {
              stage: "rewrite-upstream-hook",
              transformId: "hook:rewrite-upstream-frame",
              action: "drop",
            })
          else
            env.ctx.captureGenerationFrameAction?.([frame], [], { stage: "rewrite-upstream-hook", transformId: "hook:rewrite-upstream-frame", action: "drop" })
        } else if (rewritten !== semanticFrame) {
          if (dispatch && typeof env.ctx.captureGenerationDispatchFrameTransform === "function")
            env.ctx.captureGenerationDispatchFrameTransform(dispatch, frame, effectiveFrame, {
              stage: "rewrite-upstream-hook",
              transformId: "hook:rewrite-upstream-frame",
              forceDerived: true,
            })
          else
            env.ctx.captureGenerationFrameTransform?.(frame, effectiveFrame, {
              stage: "rewrite-upstream-hook",
              transformId: "hook:rewrite-upstream-frame",
              forceDerived: true,
            })
        }
      }

      if (effectiveFrame !== undefined) {
        for (const rewritten of passThrough([effectiveFrame], rewrites, states, 0, sampleAction, captureRewrite)) {
          if (opts?.skipRender) yield* emit([projectParsedSseFrame(rewritten)])
          else yield* emit(renderFrames((frame, requestEnv) => renderer.renderResponse(frame, requestEnv), rewritten, env, dispatch))
        }
      }
      frameIndex++
    }
    naturalDrain = true
  } finally {
    for (const flushed of flushChain(rewrites, states, captureRewrite, captureFlush)) {
      if (opts?.skipRender) yield* emit([projectParsedSseFrame(flushed)])
      else yield* emit(renderFrames((frame, requestEnv) => renderer.renderResponse(frame, requestEnv), flushed, env, dispatch))
    }
    if (!naturalDrain) input.onSettled?.()
  }

  // An upstream throw propagates after the `finally` flush and never reaches here. Therefore this
  // boundary runs only after a natural drain, exactly once.
  // Renderer flush belongs to this exact candidate instance. It runs after S5 rewrite buffers
  // drain and before protocol finish classification so meta/closing frames cannot cross siblings.
  const rendererFrames = renderer.flushResponse(env)
  const finish = opts?.finishResponse?.(rendererFrames) ?? { kind: "complete" as const, frames: rendererFrames }
  yield* emit(finish.frames)
  opts?.onFinishResolved?.(finish)
  input.onSettled?.()
}

function* renderFrames(
  renderResponse: FormatCodec["renderResponse"],
  frame: TransportUpstreamFrame,
  env: RequestEnvelope,
  dispatch?: DispatchHandle,
): Generator<ClientFrame> {
  const semanticFrame = semanticSseMessage(frame)
  const rendered = renderResponse(semanticFrame, env)
  const frames = Array.isArray(rendered) ? rendered : [rendered]
  for (const output of frames) {
    const clientFrame = output === semanticFrame ? projectParsedSseFrame(frame) : output
    const transform = {
      stage: "render",
      transformId: `render:${env.clientFormat}`,
      forceDerived: clientFrame !== frame || readSyntheticKind(clientFrame) !== undefined,
    }
    if (dispatch && typeof env.ctx.captureGenerationDispatchFrameTransform === "function")
      env.ctx.captureGenerationDispatchFrameTransform(dispatch, frame, clientFrame, transform)
    else env.ctx.captureGenerationFrameTransform?.(frame, clientFrame, transform)
    yield clientFrame
  }
}

function passThrough(
  frames: Array<TransportUpstreamFrame>,
  rewrites: ReadonlyArray<ResponseRewrite>,
  states: Array<RewriteState>,
  startIndex: number,
  sample?: (rewriteName: string, action: FrameAction) => void,
  capture?: (rewriteName: string, input: TransportUpstreamFrame, action: FrameAction) => void,
): Array<TransportUpstreamFrame> {
  let current = frames
  for (let index = startIndex; index < rewrites.length; index++) {
    const next: Array<TransportUpstreamFrame> = []
    for (const frame of current) {
      const action = rewrites[index].transform(semanticSseMessage(frame), states[index])
      sample?.(rewrites[index].name, action)
      capture?.(rewrites[index].name, frame, action)
      if (action.kind === "emit") next.push(...action.frames.map((output) => mapSemanticSseFrame(frame, () => output, action.provenance ?? "fresh")))
    }
    current = next
  }
  return current
}

function flushChain(
  rewrites: ReadonlyArray<ResponseRewrite>,
  states: Array<RewriteState>,
  capture?: (rewriteName: string, input: TransportUpstreamFrame, action: FrameAction) => void,
  captureFlush?: (rewriteName: string, outputs: ReadonlyArray<TransportUpstreamFrame>) => void,
): Array<TransportUpstreamFrame> {
  const output: Array<TransportUpstreamFrame> = []
  for (let index = 0; index < rewrites.length; index++) {
    const flushed = rewrites[index].flush?.(states[index]) ?? []
    if (rewrites[index].flush !== undefined) captureFlush?.(rewrites[index].name, flushed)
    if (flushed.length > 0) output.push(...passThrough(flushed, rewrites, states, index + 1, undefined, capture))
  }
  return output
}

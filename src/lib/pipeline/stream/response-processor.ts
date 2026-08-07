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

import type { RequestEnvelope } from "../envelope"
import type {
  //
  ClientFrame,
  CandidateResponseRenderer,
  FormatCodec,
  RunResponseOpts,
  UpstreamFrame,
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
  readonly onSettled?: () => void
}

/** Typed provenance wrapper: S5/S6 rendering failed after upstream frame acquisition. */
export class ResponseCodecRenderError extends Error {
  readonly responseFailureSource = "codec-render" as const
  readonly cause: unknown
  readonly supersededError?: unknown
  readonly supersededSource?: "upstream-transport" | "codec-render"
  readonly flushError?: unknown

  constructor(
    cause: unknown,
    diagnostics: {
      supersededError?: unknown
      supersededSource?: "upstream-transport" | "codec-render"
      flushError?: unknown
    } = {},
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "ResponseCodecRenderError"
    this.cause = cause
    this.supersededError = diagnostics.supersededError
    this.supersededSource = diagnostics.supersededSource
    this.flushError = diagnostics.flushError
  }
}

/** Works across Bun's separately transpiled test module graphs without inspecting an error message. */
export function isResponseCodecRenderError(error: unknown): error is ResponseCodecRenderError {
  return typeof error === "object" && error !== null && (error as { responseFailureSource?: unknown }).responseFailureSource === "codec-render"
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
      return processFrames({ env, dispatch: input.dispatch, upstream, opts, rewrites, states, renderer, onSettled: input.onSettled })
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
  readonly onSettled?: () => void
}

async function* processFrames(input: ProcessFramesInput): AsyncIterable<ClientFrame> {
  const { env, dispatch, upstream, opts, rewrites, states, renderer } = input
  const upstreamSse: Array<SseEventRecord> = []
  const streamStartMs = Date.now()
  let frameIndex = 0
  const onRewriteAction = opts?.onRewriteAction
  const sampleAction = onRewriteAction ? (name: string, action: FrameAction) => onRewriteAction(name, frameIndex, action) : undefined
  const bufferedInputsByRewrite = new Map<string, Array<UpstreamFrame>>()
  const captureRewrite = (name: string, frame: UpstreamFrame, action: FrameAction): void => {
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
  const captureFlush = (name: string, outputs: ReadonlyArray<UpstreamFrame>): void => {
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
  let supersededError: unknown
  let supersededSource: "upstream-transport" | "codec-render" | undefined

  try {
    for await (const frame of upstream.frames) {
      try {
        if (frame.data !== "[DONE]") {
          const upstreamRecord: SseEventRecord = {
            offsetMs: Date.now() - streamStartMs,
            type: frame.event ?? (frame.data ? "message" : "keepalive"),
            raw: frame.data ?? "",
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
          if (frame.event === "message_start") recordTiming("upstreamMessageStartAt", "once")
          if (isFirstUpstreamContent(frame, env.targetEndpoint)) recordTiming("upstreamFirstTokenAt", "once")
          if (isUpstreamContentFrame(frame, env.targetEndpoint)) recordTiming("upstreamLastTokenAt", "latest")
          opts?.onUpstreamFrame?.(frame)
        }

        try {
          const hook = getUpstreamHook()
          let effectiveFrame: UpstreamFrame | undefined = frame
          if (hook?.upstream?.inbound && frame.data !== "[DONE]") {
            const rewritten = hook.upstream.inbound(frame, env)
            effectiveFrame = rewritten !== undefined && rewritten !== frame ? tagFrameRewritten(rewritten) : rewritten
            if (effectiveFrame === undefined) {
              if (dispatch && typeof env.ctx.captureGenerationDispatchFrameAction === "function")
                env.ctx.captureGenerationDispatchFrameAction(dispatch, [frame], [], {
                  stage: "rewrite-upstream-hook",
                  transformId: "hook:rewrite-upstream-frame",
                  action: "drop",
                })
              else
                env.ctx.captureGenerationFrameAction?.([frame], [], {
                  stage: "rewrite-upstream-hook",
                  transformId: "hook:rewrite-upstream-frame",
                  action: "drop",
                })
            } else if (effectiveFrame !== frame) {
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
              if (opts?.skipRender) yield rewritten
              else yield* renderFrames((frame, requestEnv) => renderer.renderResponse(frame, requestEnv), rewritten, env, dispatch)
            }
          }
        } catch (error) {
          throw asResponseCodecRenderError(error)
        }
        frameIndex++
      } catch (error) {
        throw asResponseCodecRenderError(error)
      }
    }
    naturalDrain = true
  } catch (error) {
    supersededSource = isResponseCodecRenderError(error) ? "codec-render" : "upstream-transport"
    supersededError = isResponseCodecRenderError(error) ? error.cause : error
    throw error
  } finally {
    // Preserve the historical exception-path flush: a buffering rewrite may hold frames that still
    // must be delivered before the original failure reaches the driver. The flush chain,
    // capture callbacks, and its rendered frames are response processing rather than transport I/O.
    yield* flushResponseFrames(rewrites, states, captureRewrite, captureFlush, opts, renderer, env, dispatch, supersededError, supersededSource)
    if (!naturalDrain) input.onSettled?.()
  }

  // An upstream throw propagates after the `finally` flush and never reaches here. Therefore this
  // boundary runs only after a natural drain, exactly once. Renderer flush belongs to this candidate instance.
  const rendererFrames = renderFlush(renderer, env)
  const finish = resolveFinish(opts, rendererFrames)
  yield* finish.frames
  input.onSettled?.()
}

async function* flushResponseFrames(
  rewrites: ReadonlyArray<ResponseRewrite>,
  states: Array<RewriteState>,
  captureRewrite: (name: string, frame: UpstreamFrame, action: FrameAction) => void,
  captureFlush: (name: string, outputs: ReadonlyArray<UpstreamFrame>) => void,
  opts: RunResponseOpts | undefined,
  renderer: CandidateResponseRenderer,
  env: RequestEnvelope,
  dispatch: DispatchHandle | undefined,
  supersededError: unknown,
  supersededSource: "upstream-transport" | "codec-render" | undefined,
): AsyncIterable<ClientFrame> {
  try {
    for (const flushed of flushChain(rewrites, states, captureRewrite, captureFlush)) {
      if (opts?.skipRender) yield flushed
      else yield* renderFrames((frame, requestEnv) => renderer.renderResponse(frame, requestEnv), flushed, env, dispatch)
    }
  } catch (error) {
    const codecError = asResponseCodecRenderError(error)
    throw new ResponseCodecRenderError(codecError.cause, {
      ...(supersededError !== undefined && { supersededError }),
      ...(supersededSource !== undefined && { supersededSource }),
      flushError: codecError.cause,
    })
  }
}

export function asResponseCodecRenderError(error: unknown): ResponseCodecRenderError {
  return isResponseCodecRenderError(error) ? error : new ResponseCodecRenderError(error)
}

/** The outer handler must preserve the original renderer error in its client protocol frame. */
export function unwrapResponseCodecRenderError(error: unknown): unknown {
  return isResponseCodecRenderError(error) ? error.cause : error
}

function renderFlush(renderer: CandidateResponseRenderer, env: RequestEnvelope): ReadonlyArray<ClientFrame> {
  try {
    return renderer.flushResponse(env)
  } catch (error) {
    throw asResponseCodecRenderError(error)
  }
}

function resolveFinish(opts: RunResponseOpts | undefined, rendererFrames: ReadonlyArray<ClientFrame>): import("../types").ResponseFinishResult {
  try {
    const finish = opts?.finishResponse?.(rendererFrames) ?? { kind: "complete" as const, frames: rendererFrames }
    opts?.onFinishResolved?.(finish)
    return finish
  } catch (error) {
    throw asResponseCodecRenderError(error)
  }
}

function* renderFrames(
  renderResponse: FormatCodec["renderResponse"],
  frame: UpstreamFrame,
  env: RequestEnvelope,
  dispatch?: DispatchHandle,
): Generator<ClientFrame> {
  const rendered = renderResponse(frame, env)
  const frames = Array.isArray(rendered) ? rendered : [rendered]
  for (const output of frames) {
    const transform = {
      stage: "render",
      transformId: `render:${env.clientFormat}`,
      forceDerived: output !== frame || readSyntheticKind(output) !== undefined,
    }
    if (dispatch && typeof env.ctx.captureGenerationDispatchFrameTransform === "function")
      env.ctx.captureGenerationDispatchFrameTransform(dispatch, frame, output, transform)
    else env.ctx.captureGenerationFrameTransform?.(frame, output, transform)
    yield output
  }
}

function passThrough(
  frames: Array<UpstreamFrame>,
  rewrites: ReadonlyArray<ResponseRewrite>,
  states: Array<RewriteState>,
  startIndex: number,
  sample?: (rewriteName: string, action: FrameAction) => void,
  capture?: (rewriteName: string, input: UpstreamFrame, action: FrameAction) => void,
): Array<UpstreamFrame> {
  let current = frames
  for (let index = startIndex; index < rewrites.length; index++) {
    const next: Array<UpstreamFrame> = []
    for (const frame of current) {
      const action = rewrites[index].transform(frame, states[index])
      sample?.(rewrites[index].name, action)
      capture?.(rewrites[index].name, frame, action)
      if (action.kind === "emit") next.push(...action.frames)
    }
    current = next
  }
  return current
}

function flushChain(
  rewrites: ReadonlyArray<ResponseRewrite>,
  states: Array<RewriteState>,
  capture?: (rewriteName: string, input: UpstreamFrame, action: FrameAction) => void,
  captureFlush?: (rewriteName: string, outputs: ReadonlyArray<UpstreamFrame>) => void,
): Array<UpstreamFrame> {
  const output: Array<UpstreamFrame> = []
  for (let index = 0; index < rewrites.length; index++) {
    const flushed = rewrites[index].flush?.(states[index]) ?? []
    if (rewrites[index].flush !== undefined) captureFlush?.(rewrites[index].name, flushed)
    if (flushed.length > 0) output.push(...passThrough(flushed, rewrites, states, index + 1, undefined, capture))
  }
  return output
}

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
  readonly responseRewrites: ReadonlyArray<ResponseRewrite>
  readonly renderResponse: FormatCodec["renderResponse"]
}

/** A single-use response processor with private rewrite/translator state. */
export interface ResponseProcessor {
  readonly identity: symbol
  stream(upstream: UpstreamStream, opts?: RunResponseOpts): AsyncIterable<ClientFrame>
}

/** Create a processor whose mutable state is isolated from every sibling candidate. */
export function createResponseProcessor(input: CreateResponseProcessorInput): ResponseProcessor {
  const { env, renderResponse } = input
  const rewrites = assembleResponseRewrites(env, input.responseRewrites)
  const states: Array<RewriteState> = rewrites.map((rewrite) => rewrite.createState?.(env) ?? {})
  const identity = Symbol("responseProcessor")
  let consumed = false

  return {
    identity,
    stream(upstream, opts) {
      if (consumed) throw new Error("[response-processor] processor already consumed")
      consumed = true
      return processFrames({ env, upstream, opts, rewrites, states, renderResponse })
    },
  }
}

interface ProcessFramesInput {
  readonly env: RequestEnvelope
  readonly upstream: UpstreamStream
  readonly opts?: RunResponseOpts
  readonly rewrites: ReadonlyArray<ResponseRewrite>
  readonly states: Array<RewriteState>
  readonly renderResponse: FormatCodec["renderResponse"]
}

async function* processFrames(input: ProcessFramesInput): AsyncIterable<ClientFrame> {
  const { env, upstream, opts, rewrites, states, renderResponse } = input
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
      env.ctx.captureGenerationFrameAction?.([frame], [], { stage: "rewrite-out", transformId, action: "buffer" })
      return
    }
    const buffered = bufferedInputsByRewrite.get(name) ?? []
    bufferedInputsByRewrite.delete(name)
    const inputs = [...buffered, frame]
    env.ctx.captureGenerationFrameAction?.(inputs, action.kind === "emit" ? action.frames : [], {
      stage: "rewrite-out",
      transformId,
      action: action.kind,
      forceDerived: action.kind === "emit" && action.frames.some((output) => output !== frame || readSyntheticKind(output) !== undefined),
    })
  }
  const captureFlush = (name: string, outputs: ReadonlyArray<UpstreamFrame>): void => {
    const buffered = bufferedInputsByRewrite.get(name) ?? []
    bufferedInputsByRewrite.delete(name)
    env.ctx.captureGenerationFrameAction?.(buffered, outputs, {
      stage: "rewrite-out",
      transformId: `rewrite-out:${name}`,
      action: "flush",
      forceDerived: outputs.length > 0,
    })
  }
  const origin = readOrigin(upstream)

  try {
    for await (const frame of upstream.frames) {
      if (frame.data !== "[DONE]") {
        const upstreamRecord: SseEventRecord = {
          offsetMs: Date.now() - streamStartMs,
          type: frame.event ?? (frame.data ? "message" : "keepalive"),
          raw: frame.data ?? "",
          ...(origin && { synthetic: origin }),
        }
        upstreamSse.push(upstreamRecord)
        env.ctx.captureUpstreamGenerationFrame?.(frame, upstreamRecord)
        if (upstreamSse.length === 1) env.ctx.setSseEvents(upstreamSse)
        const now = Date.now()
        if (frame.event === "message_start") env.ctx.setAttemptTimingEpoch?.("upstreamMessageStartAt", now, "once")
        if (isFirstUpstreamContent(frame, env.targetEndpoint)) env.ctx.setAttemptTimingEpoch?.("upstreamFirstTokenAt", now, "once")
        if (isUpstreamContentFrame(frame, env.targetEndpoint)) env.ctx.setAttemptTimingEpoch?.("upstreamLastTokenAt", now, "latest")
        opts?.onUpstreamFrame?.(frame)
      }

      const hook = getUpstreamHook()
      let effectiveFrame: UpstreamFrame | undefined = frame
      if (hook?.upstream?.inbound && frame.data !== "[DONE]") {
        const rewritten = hook.upstream.inbound(frame, env)
        effectiveFrame = rewritten !== undefined && rewritten !== frame ? tagFrameRewritten(rewritten) : rewritten
        if (effectiveFrame === undefined) {
          env.ctx.captureGenerationFrameAction?.([frame], [], {
            stage: "rewrite-upstream-hook",
            transformId: "hook:rewrite-upstream-frame",
            action: "drop",
          })
        } else if (effectiveFrame !== frame) {
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
          else yield* renderFrames(renderResponse, rewritten, env)
        }
      }
      frameIndex++
    }
  } finally {
    for (const flushed of flushChain(rewrites, states, captureRewrite, captureFlush)) {
      if (opts?.skipRender) yield flushed
      else yield* renderFrames(renderResponse, flushed, env)
    }
  }
}

function* renderFrames(renderResponse: FormatCodec["renderResponse"], frame: UpstreamFrame, env: RequestEnvelope): Generator<ClientFrame> {
  const rendered = renderResponse(frame, env)
  const frames = Array.isArray(rendered) ? rendered : [rendered]
  const clientOutbound = getUpstreamHook()?.client?.outbound
  for (const output of frames) {
    env.ctx.captureGenerationFrameTransform?.(frame, output, {
      stage: "render",
      transformId: `render:${env.clientFormat}`,
      forceDerived: output !== frame || readSyntheticKind(output) !== undefined,
    })
    if (clientOutbound) {
      const hooked = clientOutbound(output, env)
      if (hooked === undefined) continue
      yield hooked
    } else {
      yield output
    }
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

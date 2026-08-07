import type { ServerSentEventMessage } from "fetch-event-stream"

import consola from "consola"

import type { ResponsesFallbackScratch } from "~/lib/codec/openai-responses/openai-responses-leg"
import type {
  //
  CandidateResponseSession,
  CandidateResponseSessionFactory,
} from "~/lib/pipeline/generation/candidate-response-session"
import type {
  //
  ClientFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type {
  //
  ResponsesPayload,
  ResponsesStreamEvent,
} from "~/types/api/openai-responses"

import { recordProtectStreamingOutcome } from "~/lib/anthropic/protect-streaming-stats"
import {
  //
  accumulateAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "~/lib/anthropic/stream-accumulator"
import { createResponsesBufferedMergeReducer } from "~/lib/codec/openai-responses/buffered-merge-reducer"
import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  accumulateResponsesStreamEvent,
  createResponsesStreamAccumulator,
} from "~/lib/openai/responses-stream-accumulator"
import { restoreResponsesStreamFrameToolNames } from "~/lib/openai/tool-name-sanitize"
import { createResponsesDeliveryProtocolAdapter } from "~/lib/pipeline/delivery/adapters/responses"
import { createCandidateResponseSession } from "~/lib/pipeline/generation/candidate-response-session"
import { classifyReverseAnthropicTerminal } from "~/lib/pipeline/reverse-terminal"
import { createUpstreamFrameDiagnostics } from "~/lib/upstream-stream-diagnostics"

import { resolveResponsesBufferedMerge } from "./buffered-config"

export type ResponsesCandidateResponseSnapshot =
  | Readonly<{
      kind: "responses"
      acc: ReturnType<typeof createResponsesStreamAccumulator>
      diag: ReturnType<typeof createUpstreamFrameDiagnostics>
      bytesIn: number
      eventsIn: number
      fallbackResponseId?: string
    }>
  | Readonly<{
      kind: "reverse-anthropic"
      anthropicAcc: ReturnType<typeof createAnthropicStreamAccumulator>
      diag: ReturnType<typeof createUpstreamFrameDiagnostics>
      bytesIn: number
      eventsIn: number
    }>

export function createResponsesCandidateResponseSessionFactory(transport: "http" | "ws"): CandidateResponseSessionFactory {
  return (input) => {
    const mapper = input.env.ctx.toolNameMapper
    const startedAtMs = Date.now()
    if (input.env.targetEndpoint === ENDPOINT.MESSAGES) {
      return createCandidateResponseSession({
        ...input,
        adapter: createResponsesDeliveryProtocolAdapter({ transport }),
        createState: () => ({
          anthropicAcc: createAnthropicStreamAccumulator(),
          diag: createUpstreamFrameDiagnostics(startedAtMs),
          bytesIn: 0,
          eventsIn: 0,
        }),
        onUpstreamFrame(state, frame) {
          const raw = frame as ServerSentEventMessage
          state.diag.observe(raw)
          if (!raw.data || raw.data === "[DONE]") return
          try {
            accumulateAnthropicStreamEvent(JSON.parse(raw.data) as never, state.anthropicAcc)
          } catch (error) {
            consola.error("[Responses:v4:reverse] Failed to parse upstream Anthropic stream event:", error, raw.data)
          }
        },
        onRenderedFrame(state, frame) {
          if (!frame.data) return undefined
          state.bytesIn += frame.data.length
          state.eventsIn++
          input.env.ctx.recordStreamProgress({ bytesIn: state.bytesIn, eventsIn: state.eventsIn })
          const event = parseResponsesEvent(frame)
          if (!event) return undefined
          return responseFrame(transport, frame, event, mapper)
        },
        finish(state, _renderer, rendererFrames) {
          const terminal = classifyReverseAnthropicTerminal(state.anthropicAcc)
          if (terminal.kind === "upstream-error") return { kind: "terminal-failure", frames: [], error: terminal.error }
          if (terminal.kind === "truncated") {
            return { kind: "truncated", frames: [], reason: "Upstream Anthropic stream truncated before completion (no message_stop)" }
          }
          return { kind: "complete", frames: rendererFrames }
        },
        snapshot: (state) => ({ kind: "reverse-anthropic" as const, ...state }),
      })
    }

    const model = (input.env.body as ResponsesPayload).model
    const fallbackResponseId = (input.env.requestState?.responsesFallbackScratch as ResponsesFallbackScratch | undefined)?.exchange?.responseId
    return createCandidateResponseSession({
      ...input,
      adapter: createResponsesDeliveryProtocolAdapter({ transport }),
      createState: () => ({
        acc: createResponsesStreamAccumulator(),
        diag: createUpstreamFrameDiagnostics(startedAtMs),
        bytesIn: 0,
        eventsIn: 0,
        // Resolved from config (spec §3 knobs; defaults drop-delta/repair-if-incomplete). Read at
        // candidate-construction time so a hot config reload takes effect on the next generation.
        bufferedMerge: createResponsesBufferedMergeReducer(resolveResponsesBufferedMerge()),
      }),
      onUpstreamFrame: (state, frame) => state.diag.observe(frame as ServerSentEventMessage),
      onRenderedFrame(state, frame) {
        if (!frame.data) return undefined
        if (transport === "http") {
          state.bytesIn += frame.data.length
          state.eventsIn++
          input.env.ctx.recordStreamProgress({ bytesIn: state.bytesIn, eventsIn: state.eventsIn })
        }
        const event = parseResponsesEvent(frame)
        if (!event) return undefined
        accumulateResponsesStreamEvent(event, state.acc)
        if (transport === "ws") {
          state.eventsIn++
          input.env.ctx.recordStreamProgress({ eventsIn: state.eventsIn })
        }
        // Feed the buffered-merge reducer the RENDERED frame (post tool-name restore) so its
        // output_item.done collection matches exactly what the flush later transforms.
        const rendered = responseFrame(transport, frame, event, mapper)
        state.bufferedMerge.observe(rendered)
        return rendered
      },
      ...(transport === "ws" && {
        stopAfterFrame: (_state: unknown, frame: ClientFrame) => {
          const event = parseResponsesEvent(frame)
          return event ? TERMINAL_EVENTS.has(event.type) : false
        },
      }),
      // Candidate-hosted buffered-merge seam (spec §4 2026-07-19 重接地). Mounted for BOTH transports:
      // HTTP flushes block-by-block (cause "boundary") + at the terminal drain; WS has no block-level
      // commit (no commitBoundaries) so it flushes ONCE at the terminal drain — the reducer's
      // reverse-scan terminal locate is correct in both cases.
      transformBufferedFlush: (state, frames, ctx) => state.bufferedMerge.transformFlush(frames, ctx),
      onBufferedResolve(state, outcome, retries, meta) {
        // Always record the merge diagnostics: the reducer ran on EVERY buffered generation (including a
        // clean first-attempt success, whose dropped/repaired counts are audit-worthy per spec §6). Placed
        // BEFORE the no-retry early return, which only skips the protect-streaming RETRY telemetry.
        input.env.ctx.recordBufferedMergeInfo(state.bufferedMerge.diagnostics())
        if (outcome === "success" && retries === 0) return
        recordProtectStreamingOutcome(outcome, retries, meta)
        input.env.ctx.recordFeature("protect-streaming-retry", { outcome, retries, vendor: meta.vendor })
        consola.debug(
          `[protect-stream:${transport === "ws" ? "responses_ws" : "responses"}] ${outcome} for ${state.acc.model || model} after ${retries} retr${retries === 1 ? "y" : "ies"}`,
        )
      },
      snapshot: (state) => ({ kind: "responses" as const, ...state, ...(fallbackResponseId && { fallbackResponseId }) }),
    })
  }
}

export function responsesCandidateSnapshot(
  driver: { getCandidateResponseSession(upstream: UpstreamStream): CandidateResponseSession | undefined },
  upstream: UpstreamStream,
): ResponsesCandidateResponseSnapshot {
  const session = driver.getCandidateResponseSession(upstream) as CandidateResponseSession<ResponsesCandidateResponseSnapshot> | undefined
  if (!session) throw new Error("[Responses:v4] candidate response session missing")
  return session.snapshot()
}

const TERMINAL_EVENTS = new Set(["response.completed", "response.failed", "response.incomplete", "error"])

function parseResponsesEvent(frame: ClientFrame): ResponsesStreamEvent | undefined {
  if (!frame.data) return undefined
  try {
    return JSON.parse(frame.data) as ResponsesStreamEvent
  } catch (error) {
    consola.debug(`[Responses:v4] skipping unparseable SSE frame (${error instanceof Error ? error.message : String(error)}):`, frame.data.slice(0, 200))
    return undefined
  }
}

export function responseFrame(
  transport: "http" | "ws",
  frame: ClientFrame,
  event: ResponsesStreamEvent,
  mapper: Parameters<typeof restoreResponsesStreamFrameToolNames>[2],
): ClientFrame {
  const data = restoreResponsesStreamFrameToolNames(frame.data ?? "", event.type, mapper)
  // Spread `...frame` so the Symbol-keyed `hook-rewrite` provenance tag (frame-origin.ts) + `id`/`retry`
  // survive the re-render (Unit 2 — was a fresh literal that dropped both). HTTP keeps the explicit
  // `event` fallback: viaFallback frames have `frame.event === undefined`, and a bare `{...frame, data}`
  // would omit the `event:` line (client-sink.ts:186) and break the wire.
  return transport === "ws" ? { ...frame, data } : { ...frame, event: frame.event ?? event.type, data }
}

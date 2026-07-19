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
import { isResponsesCommitBoundary } from "~/lib/codec/openai-responses/commit-boundaries"
import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  accumulateResponsesStreamEvent,
  createResponsesStreamAccumulator,
} from "~/lib/openai/responses-stream-accumulator"
import { restoreResponsesStreamFrameToolNames } from "~/lib/openai/tool-name-sanitize"
import { createCandidateResponseSession } from "~/lib/pipeline/generation/candidate-response-session"
import { classifyReverseAnthropicTerminal } from "~/lib/pipeline/reverse-terminal"
import { createUpstreamFrameDiagnostics } from "~/lib/upstream-stream-diagnostics"

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
      createState: () => ({
        acc: createResponsesStreamAccumulator(),
        diag: createUpstreamFrameDiagnostics(startedAtMs),
        bytesIn: 0,
        eventsIn: 0,
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
        return responseFrame(transport, frame, event, mapper)
      },
      sawMessageStop: (state) => state.acc.status !== "",
      sawUpstreamError: (state) => state.acc.streamError !== undefined,
      ...(transport === "http" && { commitBoundaries: (_state: unknown, frame: ClientFrame) => isResponsesCommitBoundary(frame) }),
      ...(transport === "ws" && {
        stopAfterFrame: (_state: unknown, frame: ClientFrame) => {
          const event = parseResponsesEvent(frame)
          return event ? TERMINAL_EVENTS.has(event.type) : false
        },
      }),
      onBufferedResolve(state, outcome, retries, meta) {
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

function responseFrame(
  transport: "http" | "ws",
  frame: ClientFrame,
  event: ResponsesStreamEvent,
  mapper: Parameters<typeof restoreResponsesStreamFrameToolNames>[2],
): ClientFrame {
  const data = restoreResponsesStreamFrameToolNames(frame.data ?? "", event.type, mapper)
  return transport === "ws" ? { data } : { event: frame.event ?? event.type, data }
}

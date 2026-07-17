import { getProcessIdentity } from "~/lib/process-identity"
import { publishModelOperationTerminal as publishTerminalToBus } from "~/lib/history/v3/terminal-bus"

import type {
  //
  AttemptHandle,
  ModelOperationRecord,
  OperationHeaderField,
  OperationKind,
  OperationTrackInput,
  OperationUsage,
  TerminalOutcome,
} from "./model-operation-record"

import { createModelOperationRecorder } from "./model-operation-record"

export const MODEL_OPERATION_TERMINAL_REGISTRY_CAPACITY = 256

const terminalRegistry = new Map<string, ModelOperationRecord>()

export type LightweightOperationSource = "upstream" | "local"

export interface LightweightOperationRoutingInput {
  readonly resolvedModel?: string
  readonly source: LightweightOperationSource
  readonly upstreamProtocol?: string
  readonly upstreamEndpoint?: string
  readonly metadata?: unknown
}

export interface LightweightAttemptInput {
  readonly source: LightweightOperationSource
  readonly effectiveRequest: unknown
  readonly wireRequest: unknown
  readonly upstreamEndpoint?: string
  readonly wireHeaders?: Headers | ReadonlyArray<OperationHeaderField>
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface LightweightAttemptSettlementInput {
  readonly result?: unknown
  readonly status?: number
  readonly headers?: Headers | ReadonlyArray<OperationHeaderField>
  readonly trailers?: Headers | ReadonlyArray<OperationHeaderField>
  readonly error?: unknown
  readonly usage?: OperationUsage
  readonly reason?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface LightweightAttempt {
  readonly handle: AttemptHandle
  commit(input: LightweightAttemptSettlementInput): void
  discard(input: LightweightAttemptSettlementInput): void
  fail(input: LightweightAttemptSettlementInput): void
}

export interface LightweightTerminalInput {
  readonly usage?: OperationUsage
  readonly metadata?: unknown
  readonly attribution?: Readonly<{
    category?: "client" | "upstream" | "proxy" | "timeout" | "shutdown" | "reaper"
    code?: string
    detail?: string
  }>
}

export interface CreateLightweightModelOperationInput {
  readonly kind: Extract<OperationKind, "count_tokens" | "embeddings">
  readonly request: Request
  readonly semanticRequest: unknown
  readonly format?: string
  readonly requestedModel?: string
  readonly metadata?: unknown
}

export interface LightweightModelOperation {
  readonly operationId: string
  recordRouting(input: LightweightOperationRoutingInput): void
  beginAttempt(input: LightweightAttemptInput): LightweightAttempt
  complete(response: Response, input?: LightweightTerminalInput): Promise<ModelOperationRecord>
  fail(response: Response, error: unknown, input?: LightweightTerminalInput): Promise<ModelOperationRecord>
  abort(response: Response, error: unknown, input?: LightweightTerminalInput): Promise<ModelOperationRecord>
}

function headersToFields(headers: Headers | ReadonlyArray<OperationHeaderField> | undefined): ReadonlyArray<OperationHeaderField> | undefined {
  if (headers === undefined) return undefined
  if (headers instanceof Headers) return [...headers.entries()].map(([name, value]) => [name, value] as const)
  return headers
}

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  const candidate = error as Error & {
    status?: number
    responseText?: string
    responseHeaders?: Headers
    code?: string | number
    cause?: unknown
  }
  return {
    name: candidate.name,
    message: candidate.message,
    ...(candidate.stack === undefined ? {} : { stack: candidate.stack }),
    ...(candidate.status === undefined ? {} : { status: candidate.status }),
    ...(candidate.responseText === undefined ? {} : { responseText: candidate.responseText }),
    ...(candidate.responseHeaders === undefined ? {} : { responseHeaders: headersToFields(candidate.responseHeaders) }),
    ...(candidate.code === undefined ? {} : { code: candidate.code }),
    ...(candidate.cause === undefined ? {} : { cause: serializeError(candidate.cause) }),
  }
}

function parseSemanticEnvelope(text: string, contentType: string | null): unknown {
  if (text.length === 0) return null
  if (contentType?.includes("json")) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

async function responseEnvelope(response: Response): Promise<unknown> {
  const copy = response.clone()
  return parseSemanticEnvelope(await copy.text(), copy.headers.get("content-type"))
}

function rawCaptureGap(): OperationTrackInput["rawCapture"] {
  return {
    capability: "unavailable",
    gap: "WHATWG Request/Response exposes semantic headers and envelopes, not exact bytes, repeated header tuples, or original field ordering",
  }
}

function publishTerminal(record: ModelOperationRecord): void {
  terminalRegistry.set(record.identity.operationId, record)
  publishTerminalToBus(record)
  while (terminalRegistry.size > MODEL_OPERATION_TERMINAL_REGISTRY_CAPACITY) {
    const oldest = terminalRegistry.keys().next().value
    if (oldest === undefined) break
    terminalRegistry.delete(oldest)
  }
}

/** Immutable terminal snapshots in completion order. The registry is bounded. */
export function listTerminalModelOperations(): ReadonlyArray<ModelOperationRecord> {
  return Object.freeze([...terminalRegistry.values()])
}

/** Read one terminal snapshot without changing registry ownership. */
export function getTerminalModelOperation(operationId: string): ModelOperationRecord | undefined {
  return terminalRegistry.get(operationId)
}

/** Transfer one terminal snapshot to a consumer and release its registry slot. */
export function consumeTerminalModelOperation(operationId: string): ModelOperationRecord | undefined {
  const record = terminalRegistry.get(operationId)
  if (record !== undefined) terminalRegistry.delete(operationId)
  return record
}

/** Test isolation for the module-global bounded registry. */
export function resetModelOperationTerminalRegistryForTests(): void {
  terminalRegistry.clear()
}

/**
 * Build a canonical lifecycle for a bypass operation without constructing a
 * RequestContext or publishing V2 observability/history events.
 */
export function createLightweightModelOperation(input: CreateLightweightModelOperationInput): LightweightModelOperation {
  const operationId = crypto.randomUUID()
  const recorder = createModelOperationRecorder({
    identity: {
      operationId,
      kind: input.kind,
      createdAt: Date.now(),
      clientRequestId: input.request.headers.get("x-request-id") ?? input.request.headers.get("request-id") ?? undefined,
      process: getProcessIdentity(),
    },
  })
  const ingressPayload = recorder.registerPayload(input.semanticRequest, {
    origin: { stage: "ingress", track: "client" },
    mediaType: input.request.headers.get("content-type") ?? "application/json",
  })
  recorder.recordIngress({
    request: {
      payload: ingressPayload,
      headers: headersToFields(input.request.headers),
      rawCapture: rawCaptureGap(),
      metadata: input.semanticRequest,
    },
    format: input.format,
    method: input.request.method,
    path: new URL(input.request.url).pathname,
    metadata: input.metadata,
  })

  let routingRecorded = false
  let committedAttempt: AttemptHandle | undefined
  let latestResultTrack: OperationTrackInput | undefined
  let terminalRecord: ModelOperationRecord | null = null

  function recordRouting(routing: LightweightOperationRoutingInput): void {
    recorder.recordRouting({
      requestedModel: input.requestedModel,
      resolvedModel: routing.resolvedModel,
      clientFormat: input.format,
      upstreamProtocol: routing.upstreamProtocol,
      upstreamEndpoint: routing.upstreamEndpoint,
      transport: routing.source === "local" ? "local" : "http",
      metadata: { source: routing.source, detail: routing.metadata },
    })
    routingRecorded = true
  }

  function beginAttempt(attemptInput: LightweightAttemptInput): LightweightAttempt {
    if (!routingRecorded) throw new Error("[lightweight-model-operation] routing must be recorded before an attempt begins")
    const effectivePayload = recorder.registerPayload(attemptInput.effectiveRequest, {
      origin: { stage: "effective-request", track: attemptInput.source === "local" ? "internal" : "proxy" },
      mediaType: "application/json",
    })
    const wirePayload = recorder.registerPayload(attemptInput.wireRequest, {
      origin: { stage: attemptInput.source === "local" ? "local-wire" : "upstream-wire", track: attemptInput.source === "local" ? "internal" : "upstream" },
      mediaType: "application/json",
    })
    const startedAt = performance.now()
    const handle = recorder.beginAttempt({
      ...(attemptInput.source === "upstream" ? { transport: "http" as const } : {}),
      effectiveRequest: { payload: effectivePayload, metadata: attemptInput.effectiveRequest },
      upstreamRequest: {
        payload: wirePayload,
        ...(attemptInput.wireHeaders === undefined ? {} : { headers: headersToFields(attemptInput.wireHeaders) }),
        rawCapture: rawCaptureGap(),
        metadata: { source: attemptInput.source, endpoint: attemptInput.upstreamEndpoint },
      },
      metadata: { source: attemptInput.source, endpoint: attemptInput.upstreamEndpoint, ...attemptInput.metadata },
    })
    let settled = false

    function settle(verdict: "committed" | "discarded" | "failed", settlement: LightweightAttemptSettlementInput): void {
      if (settled) throw new Error(`[lightweight-model-operation] attempt already settled: ${handle}`)
      settled = true
      const latencyMs = performance.now() - startedAt
      const result = settlement.result ?? (settlement.error === undefined ? undefined : serializeError(settlement.error))
      const responsePayload =
        result === undefined ? undefined : (
          recorder.registerPayload(result, {
            origin: {
              stage: attemptInput.source === "local" ? "local-result" : "upstream-response",
              track: attemptInput.source === "local" ? "internal" : "upstream",
              attempt: handle,
            },
            mediaType: "application/json",
          })
        )
      const responseTrack: OperationTrackInput = {
        ...(responsePayload === undefined ? {} : { payload: responsePayload }),
        ...(settlement.status === undefined ? {} : { status: settlement.status }),
        ...(settlement.headers === undefined ? {} : { headers: headersToFields(settlement.headers) }),
        ...(settlement.trailers === undefined ? {} : { trailers: headersToFields(settlement.trailers) }),
        rawCapture: rawCaptureGap(),
        metadata: {
          source: attemptInput.source,
          latencyMs,
          ...(settlement.usage === undefined ? {} : { usage: settlement.usage }),
          ...settlement.metadata,
        },
      }
      recorder.settleAttempt(handle, {
        verdict,
        upstreamResponse: responseTrack,
        reason: settlement.reason,
        error: settlement.error === undefined ? undefined : serializeError(settlement.error),
        metadata: {
          source: attemptInput.source,
          latencyMs,
          ...(settlement.usage === undefined ? {} : { usage: settlement.usage }),
          ...settlement.metadata,
        },
        extensions: { "history-v3.lightweight": { latencyMs, source: attemptInput.source } },
      })
      latestResultTrack = responseTrack
      if (verdict === "committed") committedAttempt = handle
    }

    return Object.freeze({
      handle,
      commit: (settlement: LightweightAttemptSettlementInput) => settle("committed", settlement),
      discard: (settlement: LightweightAttemptSettlementInput) => settle("discarded", settlement),
      fail: (settlement: LightweightAttemptSettlementInput) => settle("failed", settlement),
    })
  }

  async function finalize(
    response: Response,
    outcome: TerminalOutcome,
    error: unknown,
    terminalInput: LightweightTerminalInput,
  ): Promise<ModelOperationRecord> {
    if (terminalRecord) return terminalRecord
    const clientEnvelope = await responseEnvelope(response)
    const clientPayload = recorder.registerPayload(clientEnvelope, {
      origin: { stage: "client-egress", track: "client" },
      mediaType: response.headers.get("content-type") ?? "application/json",
    })
    recorder.recordEgress({
      upstream: latestResultTrack,
      client: {
        payload: clientPayload,
        status: response.status,
        headers: headersToFields(response.headers),
        rawCapture: rawCaptureGap(),
        metadata: clientEnvelope,
      },
    })
    terminalRecord = recorder.commitTerminal({
      outcome,
      committedAttempt,
      ...(error === undefined ? {} : { error: serializeError(error) }),
      usage: terminalInput.usage,
      attribution: terminalInput.attribution,
      metadata: terminalInput.metadata,
    })
    publishTerminal(terminalRecord)
    return terminalRecord
  }

  return Object.freeze({
    operationId,
    recordRouting,
    beginAttempt,
    complete: (response: Response, terminalInput: LightweightTerminalInput = {}) => finalize(response, "completed", undefined, terminalInput),
    fail: (response: Response, error: unknown, terminalInput: LightweightTerminalInput = {}) => finalize(response, "failed", error, terminalInput),
    abort: (response: Response, error: unknown, terminalInput: LightweightTerminalInput = {}) => finalize(response, "aborted", error, terminalInput),
  })
}

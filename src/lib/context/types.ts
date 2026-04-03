import type { ApiError } from "~/lib/error"
import type {
  EndpointType,
  PipelineInfo,
  RequestLifecycleState,
  RequestTransport,
  SanitizationInfo,
  SseEventRecord,
  TruncationInfo,
  WarningMessage,
} from "~/lib/history/store"
import type { Model } from "~/lib/models/client"

// ─── Request State Machine ───

export type RequestState = RequestLifecycleState

// ─── Four-Part Data Model ───

/** 1. Original request: client's raw payload (one per request, immutable) */
export interface OriginalRequest {
  model: string
  messages: Array<unknown>
  stream: boolean
  tools?: Array<unknown>
  system?: unknown
  /** Full raw payload — used by toHistoryEntry() to extract max_tokens, temperature, thinking etc. */
  payload: unknown
}

/** 2. Effective request: logical payload after sanitize/truncate/retry (before client-specific wire mutations) */
export interface EffectiveRequest {
  model: string
  resolvedModel: Model | undefined
  messages: Array<unknown>
  payload: unknown
  format: EndpointType
}

/** 3. Wire request: final HTTP payload/headers sent upstream (per attempt) */
export interface WireRequest {
  model: string
  messages: Array<unknown>
  payload: unknown
  headers: Record<string, string>
  format: EndpointType
}

/** 4. Response data: upstream API response (per attempt) */
export interface ResponseData {
  success: boolean
  model: string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    output_tokens_details?: { reasoning_tokens: number }
  }
  content: unknown
  stop_reason?: string
  error?: string
  /** HTTP status code from upstream (only on error) */
  status?: number
  /** Raw response body from upstream (only on error, for post-mortem debugging) */
  responseText?: string
}

// ─── Attempt ───

/** A single API call attempt (each retry produces a new Attempt) */
export interface Attempt {
  index: number
  effectiveRequest: EffectiveRequest | null
  wireRequest: WireRequest | null
  response: ResponseData | null
  error: ApiError | null
  transport: RequestTransport
  /** Strategy that triggered this retry (undefined for first attempt) */
  strategy?: string
  sanitization?: SanitizationInfo
  truncation?: TruncationInfo
  /** Wait time before this retry (rate-limit) */
  waitMs?: number
  startTime: number
  durationMs: number
}

// ─── History Entry Data ───

/** Mutable capture object for HTTP headers (filled by client functions after fetch) */
export interface HeadersCapture {
  request?: Record<string, string>
  response?: Record<string, string>
}

/** Serialized form of a completed request (decoupled from history store) */
export interface HistoryEntryData {
  id: string
  endpoint: EndpointType
  rawPath?: string
  startedAt: number
  endedAt: number
  state: RequestState
  active: boolean
  lastUpdatedAt: number
  queueWaitMs: number
  attemptCount: number
  currentStrategy?: string
  durationMs: number
  sessionId?: string
  transport?: RequestTransport
  warningMessages?: Array<WarningMessage>

  request: {
    model?: string
    messages?: Array<unknown>
    stream?: boolean
    tools?: Array<unknown>
    system?: unknown
    max_tokens?: number
    temperature?: number
    thinking?: unknown
  }

  effectiveRequest?: {
    model?: string
    format?: EndpointType
    messageCount?: number
    messages?: Array<unknown>
    system?: unknown
    payload?: unknown
  }

  wireRequest?: {
    model?: string
    format?: EndpointType
    messageCount?: number
    messages?: Array<unknown>
    system?: unknown
    payload?: unknown
    headers?: Record<string, string>
  }

  response?: ResponseData
  truncation?: TruncationInfo
  pipelineInfo?: PipelineInfo
  sseEvents?: Array<SseEventRecord>
  httpHeaders?: {
    request: Record<string, string>
    response: Record<string, string>
  }
  attempts?: Array<{
    index: number
    strategy?: string
    durationMs: number
    transport?: RequestTransport
    error?: string
    truncation?: TruncationInfo
    sanitization?: SanitizationInfo
    effectiveMessageCount?: number
  }>
}

// ─── RequestContext Event ───

export interface RequestContextEventData {
  type: string
  context: RequestContext
  previousState?: RequestState
  field?: string
  meta?: Record<string, unknown>
  entry?: HistoryEntryData
}

export type RequestContextEventCallback = (event: RequestContextEventData) => void

// ─── RequestContext Interface ───

export interface RequestContext {
  readonly id: string
  readonly sessionId: string | undefined
  readonly tuiLogId: string | undefined
  readonly rawPath: string | undefined
  readonly startTime: number
  readonly endTime: number | null
  readonly endpoint: EndpointType
  readonly state: RequestState
  readonly durationMs: number
  /** Whether this context has been settled (completed or failed). Handler code can check this to detect reaper force-fail. */
  readonly settled: boolean

  readonly originalRequest: OriginalRequest | null
  readonly response: ResponseData | null
  readonly pipelineInfo: PipelineInfo | null
  readonly httpHeaders: { request: Record<string, string>; response: Record<string, string> } | null
  readonly transport: RequestTransport | null

  readonly attempts: ReadonlyArray<Attempt>
  readonly currentAttempt: Attempt | null
  readonly queueWaitMs: number
  readonly warningMessages: ReadonlyArray<WarningMessage>

  setSessionId(sessionId: string | undefined): void
  setOriginalRequest(req: OriginalRequest): void
  setPipelineInfo(info: PipelineInfo): void
  setSseEvents(events: Array<SseEventRecord>): void
  setHttpHeaders(capture: HeadersCapture): void
  addWarningMessage(warning: WarningMessage): void
  beginAttempt(opts: {
    strategy?: string
    waitMs?: number
    truncation?: TruncationInfo
    transport?: RequestTransport
  }): void
  setAttemptSanitization(info: SanitizationInfo): void
  setAttemptEffectiveRequest(req: EffectiveRequest): void
  setAttemptWireRequest(req: WireRequest): void
  setAttemptTransport(transport: RequestTransport): void
  setAttemptResponse(response: ResponseData): void
  setAttemptError(error: ApiError): void
  addQueueWaitMs(ms: number): void
  transition(newState: RequestState, meta?: Record<string, unknown>): void
  complete(response: ResponseData): void
  fail(model: string, error: unknown): void
  toHistoryEntry(): HistoryEntryData
}

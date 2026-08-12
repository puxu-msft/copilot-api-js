/**
 * Supported API endpoint types.
 *
 * `openai-embeddings` is written by the embeddings producer (`routes/embeddings/route.ts`) and
 * reaches the `endpoint` column through `v3/projection.ts`, so omitting it made legitimate records
 * unrepresentable — the read path judged them poison and the list validator rejected the value as
 * unknown. Adding it is the prerequisite fix that `docs/spec/2026-07-28-history-read-path-core.md`
 * §5.7.4 requires before any endpoint-enum gate.
 */
export type EndpointType = "anthropic-messages" | "openai-chat-completions" | "openai-responses" | "gemini-generate-content" | "openai-embeddings"

/** Lifecycle state shared by rich history records and narrow read projections. */
export type RequestLifecycleState = "pending" | "executing" | "streaming" | "completed" | "failed" | "aborted" | "interrupted"

export interface QueryOptions {
  /** Canonical operation kind. Default generation; `all` includes bypass operations. */
  operationKind?: "generation" | "count_tokens" | "embeddings" | "responses_ws" | "all"
  cursor?: string
  limit?: number
  direction?: "older" | "newer"
  model?: string
  endpoint?: EndpointType
  success?: boolean
  /** Exact lifecycle-state filter. When both are present, both predicates apply; a conflict matches nothing. */
  state?: RequestLifecycleState
  /** Exclude active in-flight entries from the merged result. */
  terminalOnly?: boolean
  from?: number
  to?: number
  search?: string
  sessionId?: string
  /** Filter to a specific subagent id. */
  agentId?: string
  /** Filter to the main agent only. `agentId` wins when both are present. */
  mainAgentOnly?: boolean
  /** Filter to records produced by a specific process. */
  pid?: number
}

export interface HistoryStats {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  abortedRequests: number
  interruptedRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  averageDurationMs: number
  modelDistribution: Record<string, number>
  endpointDistribution: Record<string, number>
  recentActivity: Array<{ hour: string; count: number }>
  activeSessions: number
}

/** Per-session aggregate row over ready terminal V3 summary rows. */
export interface SessionSummary {
  sessionId: string
  requestCount: number
  /** Distinct subagents only; main-agent rows have a NULL agent id. */
  agentCount: number
  /** Fresh input plus cache-read and cache-creation tokens. */
  inputTokens: number
  outputTokens: number
  firstStartedAt: number
  lastStartedAt: number
  completed: number
  failed: number
  /** Aborted plus interrupted terminal entries. */
  aborted: number
  models: Array<string>
  firstPreview: string
  preview: string
}

/**
 * Compact transport-level failure classification for list display and grouping.
 *
 * Additive and frequently absent: a request that ended cleanly has none, and so does every request that predates the A4 transport diagnostics. Absence therefore means "nothing to report OR not recorded", never "the transport was healthy".
 *
 * The full evidence stays in the dispatch's `transport.h2.*` diagnostics; this is only the headline.
 */
export interface EntryTransportFailure {
  /**
   * What the transport actually observed — deliberately NOT "who cancelled".
   *
   * `transport-error` is not narrowed to "the peer reset us", because that cannot be established from the stream alone: a local abort, a genuine peer RST_STREAM(CANCEL) and a dead connection all surface with `rstCode` 8, and only the presence of a stream error separates them — and only on some runtimes (measured, `exp/h2-termination-observability/`). Claiming a culprit here would be inventing one.
   *
   * Named `transport-error` rather than `stream-error` on purpose: the latter is an existing pipeline OUTCOME with a single-minting guard, and reusing the word here would give one term two meanings in one codebase.
   */
  kind: "local-cancel" | "transport-error" | "forced-teardown" | "session-goaway"
  /**
   * The h2 CONNECTION this ran on, so siblings that died together can be correlated.
   *
   * ⚠️ Not `EntrySummary.sessionId`, which is the client conversation. Two different identity domains.
   */
  h2SessionId?: string
  rstCode?: number
  /** Set only when the local side initiated the cancel, which is the one thing observable by construction. */
  localCancelSource?: string
}

export interface EntrySummary {
  id: string
  operationKind?: "generation" | "count_tokens" | "embeddings" | "responses_ws"
  sessionId?: string
  agentId?: string
  rawPath?: string
  startedAt: number
  endedAt?: number
  endpoint: EndpointType
  state?: RequestLifecycleState
  active?: boolean
  /** Recent terminal has not reached durable V3 storage, or its bounded writer attempt failed. */
  durability?: "pending" | "failed"
  pinned?: boolean
  lastUpdatedAt?: number
  queueWaitMs?: number
  historyAdmissionWaitMs?: number
  attemptCount?: number
  currentStrategy?: string
  pid?: number
  requestModel?: string
  stream?: boolean
  messageCount: number
  responseModel?: string
  responseSuccess?: boolean
  responseError?: string
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  durationMs?: number
  timing?: { operation?: { source: "canonical" | "storage-commit-upper-bound" | "terminal-log-rounded" | "unavailable" } }
  requestBytes?: number
  responseBytes?: number
  multiplier?: number
  previewText: string
  responsePreviewText: string
  /** Absent when nothing went wrong at the transport, and also when the request predates A4 diagnostics. */
  transportFailure?: EntryTransportFailure
}

export interface SummaryResult {
  entries: Array<EntrySummary>
  total: number
  nextCursor: string | null
  prevCursor: string | null
}

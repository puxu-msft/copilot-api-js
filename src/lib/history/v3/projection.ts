import type {
  //
  ModelOperationRecord,
  OperationTrack,
} from "~/lib/context/model-operation-record"
import type {
  //
  EntrySummary,
  HistoryEntry,
  HistoryState,
  QueryOptions,
  SseEventRecord,
} from "~/lib/history/types"

function nodeValues(record: ModelOperationRecord): Map<string, unknown> {
  return new Map([...record.arena.payloads, ...record.arena.frames].map((node) => [node.handle, node.value]))
}

function payload(values: Map<string, unknown>, track: OperationTrack | undefined): unknown {
  return track?.payload ? values.get(track.payload) : undefined
}

function headers(track: OperationTrack | undefined): Record<string, string> | undefined {
  if (!track?.headers) return undefined
  const out: Record<string, string> = {}
  for (const [name, value] of track.headers) out[name] = Object.hasOwn(out, name) ? `${out[name]}, ${value}` : value
  return out
}

function frames(values: Map<string, unknown>, track: OperationTrack | undefined): Array<SseEventRecord> | undefined {
  if (!track) return undefined
  if (track.frames.length === 0) return undefined
  return track.frames.map((handle, index) => {
    const value = values.get(handle) as { offsetMs?: number; type?: string; raw?: string; data?: string; synthetic?: SseEventRecord["synthetic"] } | undefined
    return {
      offsetMs: value?.offsetMs ?? index,
      type: value?.type ?? "message",
      raw: value?.raw ?? value?.data ?? "",
      ...(value?.synthetic ? { synthetic: value.synthetic } : {}),
    }
  })
}

function metadata(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  const candidate = metadata(value)?.message
  return typeof candidate === "string" ? candidate : JSON.stringify(value)
}

function projectUsage(value: Record<string, unknown> | undefined): NonNullable<NonNullable<HistoryEntry["attempts"]>[number]["upstreamResponse"]>["usage"] {
  if (!value) return undefined
  if ("input_tokens" in value || "output_tokens" in value)
    return value as unknown as NonNullable<NonNullable<HistoryEntry["attempts"]>[number]["upstreamResponse"]>["usage"]
  return {
    input_tokens: typeof value.inputTokens === "number" ? value.inputTokens : 0,
    output_tokens: typeof value.outputTokens === "number" ? value.outputTokens : 0,
    ...(typeof value.cacheReadTokens === "number" && { cache_read_input_tokens: value.cacheReadTokens }),
    ...(typeof value.cacheWriteTokens === "number" && { cache_creation_input_tokens: value.cacheWriteTokens }),
    ...(typeof value.reasoningTokens === "number" && { output_tokens_details: { reasoning_tokens: value.reasoningTokens } }),
  }
}

function lifecycleState(record: ModelOperationRecord): HistoryState["enabled"] extends boolean ? HistoryEntry["state"] : never {
  switch (record.terminal?.outcome) {
    case "completed": {
      return "completed"
    }
    case "aborted":
    case "cancelled": {
      return "aborted"
    }
    case "interrupted": {
      return "interrupted"
    }
    default: {
      return "failed"
    }
  }
}

/** Pure terminal projection. Canonical record remains the authority. */
export function recordToHistoryEntry(record: ModelOperationRecord, stored: { pinned?: boolean } = {}): HistoryEntry {
  const values = nodeValues(record)
  const ingressMeta = metadata(record.ingress?.request.metadata) as
    | { model?: string; messages?: Array<unknown>; stream?: boolean; tools?: Array<unknown>; system?: unknown; payload?: unknown }
    | undefined
  const clientBody = payload(values, record.ingress?.request)
  const attempts = record.attempts.map((attempt, index) => {
    const effectiveMeta = metadata(attempt.effectiveRequest?.metadata)
    const requestMeta = metadata(attempt.upstreamRequest?.metadata)
    const responseMeta = metadata(attempt.upstreamResponse?.metadata) as
      | {
          response?: { success?: boolean; model?: string; usage?: Record<string, unknown>; stop_reason?: string; responseId?: string; error?: string }
          source?: string
          latencyMs?: number
          usage?: Record<string, unknown>
        }
      | undefined
    const response = responseMeta?.response
    return {
      index,
      strategy: attempt.strategy,
      durationMs: responseMeta?.latencyMs ?? 0,
      transport: metadata(attempt.metadata)?.transport as HistoryEntry["transport"] | undefined,
      ...(attempt.error ? { error: errorMessage(attempt.error) } : {}),
      effectiveSource: {
        ...effectiveMeta,
        body: payload(values, attempt.effectiveRequest),
      },
      upstreamRequest: {
        ...requestMeta,
        body: payload(values, attempt.upstreamRequest),
        headers: headers(attempt.upstreamRequest),
      },
      upstreamResponse: {
        success: response?.success ?? attempt.verdict === "committed",
        status: attempt.upstreamResponse?.status,
        headers: headers(attempt.upstreamResponse),
        body: payload(values, attempt.upstreamResponse) as NonNullable<NonNullable<HistoryEntry["attempts"]>[number]["upstreamResponse"]>["body"],
        sseEvents: frames(values, attempt.upstreamResponse),
        usage: projectUsage(
          response?.usage
            ?? responseMeta?.usage
            ?? (index === record.attempts.length - 1 ? (record.terminal?.usage as Record<string, unknown> | undefined) : undefined),
        ),
        stopReason: response?.stop_reason,
        model: response?.model ?? record.routing?.resolvedModel,
        responseId: response?.responseId,
      },
    } satisfies NonNullable<HistoryEntry["attempts"]>[number]
  })
  const state = lifecycleState(record)
  const lastAttempt = attempts.at(-1)
  const clientTrack = record.egress?.client
  const clientPayload = payload(values, clientTrack)
  const clientMetadata = metadata(clientTrack?.metadata)
  return {
    id: record.identity.operationId,
    operationKind: record.identity.kind,
    sessionId: record.identity.sessionId,
    agentId: record.identity.agentId,
    startedAt: record.identity.createdAt,
    endedAt: record.identity.createdAt + Math.max(0, (record.terminal?.sequence ?? record.lastSequence) - 1),
    durationMs: metadata(record.terminal?.metadata)?.durationMs as number | undefined,
    endpoint: (record.ingress?.format ?? "unknown") as HistoryEntry["endpoint"],
    state,
    active: false,
    pinned: stored.pinned ?? false,
    lastUpdatedAt: record.identity.createdAt,
    process:
      record.identity.process?.bootTime !== undefined && record.identity.process.version !== undefined ?
        (record.identity.process as HistoryEntry["process"])
      : undefined,
    transport: record.routing?.transport as HistoryEntry["transport"],
    model: {
      requested: record.routing?.requestedModel ?? ingressMeta?.model,
      resolved: record.routing?.resolvedModel,
      outboundEndpoint: record.routing?.upstreamEndpoint,
      translated: metadata(record.routing?.metadata)?.translated as boolean | undefined,
    },
    clientRequest: {
      method: record.ingress?.method,
      path: record.ingress?.path,
      format: record.ingress?.format as HistoryEntry["endpoint"],
      headers: headers(record.ingress?.request),
      body: clientBody,
      model: ingressMeta?.model,
      messages: ingressMeta?.messages as NonNullable<HistoryEntry["clientRequest"]>["messages"],
      stream: ingressMeta?.stream,
      tools: ingressMeta?.tools as NonNullable<HistoryEntry["clientRequest"]>["tools"],
      system: ingressMeta?.system as NonNullable<HistoryEntry["clientRequest"]>["system"],
    },
    clientResponse: {
      status: clientTrack?.status,
      headers: headers(clientTrack),
      body: clientPayload ?? clientMetadata?.content,
      sseEvents: frames(values, clientTrack),
    },
    attempts,
    _index: {
      derived: {
        responseSuccess: state === "completed",
        currentStrategy: lastAttempt?.strategy,
        failureReason: state === "completed" ? undefined : errorMessage(record.terminal?.error),
        attemptCount: attempts.length,
      },
      aux: {},
    },
  }
}

export function recordToEntrySummary(record: ModelOperationRecord, stored: { pinned?: boolean } = {}): EntrySummary {
  const entry = recordToHistoryEntry(record, stored)
  const last = entry.attempts?.at(-1)?.upstreamResponse
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    agentId: entry.agentId,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    endpoint: entry.endpoint,
    state: entry.state,
    active: false,
    pinned: stored.pinned ?? false,
    lastUpdatedAt: entry.lastUpdatedAt,
    requestModel: entry.model?.requested,
    responseModel: last?.model ?? entry.model?.resolved,
    responseSuccess: entry.state === "completed",
    responseError: entry._index?.derived?.failureReason,
    messageCount: entry.clientRequest?.messages?.length ?? 0,
    usage: last?.usage,
    durationMs: entry.durationMs,
    previewText: "",
    responsePreviewText: "",
  }
}

export function recordMatchesQuery(record: ModelOperationRecord, options: QueryOptions & { operationKind?: string }): boolean {
  if (options.operationKind && options.operationKind !== "all" && record.identity.kind !== options.operationKind) return false
  if (options.sessionId && record.identity.sessionId !== options.sessionId) return false
  if (options.agentId && record.identity.agentId !== options.agentId) return false
  if (!options.agentId && options.mainAgentOnly && record.identity.agentId !== undefined) return false
  if (options.pid !== undefined && record.identity.process?.pid !== options.pid) return false
  if (options.endpoint && record.ingress?.format !== options.endpoint) return false
  if (options.model) {
    const needle = options.model.toLowerCase()
    if (![record.routing?.requestedModel, record.routing?.resolvedModel].some((model) => model?.toLowerCase().includes(needle))) return false
  }
  const state = lifecycleState(record)
  if (options.state && state !== options.state) return false
  if (options.success !== undefined && (state === "completed") !== options.success) return false
  if (options.from !== undefined && record.identity.createdAt < options.from) return false
  if (options.to !== undefined && record.identity.createdAt > options.to) return false
  return true
}

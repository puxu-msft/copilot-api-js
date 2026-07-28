import type { HistoryEntryData } from "~/lib/context/types"
import type {
  //
  AttemptSnapshot,
  FeatureKind,
  ObservabilityEvent,
  RequestContextSnapshot,
} from "~/lib/observability"

import { isTerminalState } from "~/lib/history/lifecycle-state"
import { assertNever } from "~/lib/observability"

import { sanitizeTerminalText } from "./render/sanitize"

export interface ActiveRequest {
  ctx: RequestContextSnapshot
  streamBytesIn?: number
  streamEventsIn?: number
  streamBlockType?: string
  tags: Array<string>
  recoveredToolNames?: Array<string>
  thinking?: { requested?: string; effective: string }
  isHistoryAccess: boolean
  statusCode?: number
  attemptCount: number
  attempts: Array<AttemptSnapshot>
}

export type RequestDisplayEffect =
  | { kind: "created"; entry: ActiveRequest }
  | { kind: "retry"; entry: ActiveRequest; event: Extract<RequestEvent, { kind: "request.attempt_failed" }> }
  | {
      kind: "terminal"
      entry: ActiveRequest
      outcome: "completed" | "failed" | "aborted"
      error?: string
      statusCode?: number
      historyEntry: HistoryEntryData
    }

export type RequestEvent = Extract<ObservabilityEvent, { kind: `request.${string}` }>

export interface StoreChange {
  previousIds: Array<string>
  activeIds: Array<string>
  removed?: { id: string; index: number }
  effects: Array<RequestDisplayEffect>
}

/** Pure request-event reducer and sole owner of active-request display projections. */
export class ActiveRequestStore {
  private readonly entries = new Map<string, ActiveRequest>()

  get size(): number {
    return this.entries.size
  }

  get(id: string): ActiveRequest | undefined {
    return this.entries.get(id)
  }

  values(): IterableIterator<ActiveRequest> {
    return this.entries.values()
  }

  orderedIds(): Array<string> {
    return [...this.entries.keys()]
  }

  snapshot(): ReadonlyArray<ActiveRequest> {
    return [...this.entries.values()]
  }

  apply(event: RequestEvent): StoreChange {
    const previousIds = this.orderedIds()
    const effects: Array<RequestDisplayEffect> = []
    let removed: StoreChange["removed"]

    switch (event.kind) {
      case "request.created": {
        const entry = this.upsert(event.ctx).entry
        effects.push({ kind: "created", entry })
        break
      }
      case "request.model_resolved":
      case "request.state_changed": {
        this.upsert(event.ctx)
        break
      }
      case "request.attempt_started": {
        const entry = this.upsert(event.ctx).entry
        entry.attemptCount = Math.max(entry.attemptCount, event.attempt.attemptIndex + 1)
        mergeAttempt(entry, event.attempt)
        break
      }
      case "request.attempt_failed": {
        const entry = this.upsert(event.ctx).entry
        entry.attemptCount = Math.max(entry.attemptCount, event.attempt.attemptIndex + 1)
        mergeAttempt(entry, event.attempt)
        if (event.willRetry) effects.push({ kind: "retry", entry, event })
        break
      }
      case "request.stream_progress": {
        const entry = this.upsert(event.ctx).entry
        if (event.bytesIn !== undefined) entry.streamBytesIn = event.bytesIn
        if (event.eventsIn !== undefined) entry.streamEventsIn = event.eventsIn
        if (event.blockType !== undefined) entry.streamBlockType = sanitizeTerminalText(event.blockType)
        break
      }
      case "request.feature_applied": {
        projectFeature(this.upsert(event.ctx).entry, event.feature, event.detail)
        break
      }
      case "request.completed":
      case "request.failed":
      case "request.aborted": {
        const index = previousIds.indexOf(event.ctx.id)
        const entry = this.entries.get(event.ctx.id) ?? newEntry(event.ctx)
        this.entries.delete(event.ctx.id)
        entry.ctx = event.ctx
        const outcome = event.kind.slice("request.".length) as "completed" | "failed" | "aborted"
        let statusCode: number | undefined
        if (event.kind === "request.completed") statusCode = 200
        else if (event.kind === "request.failed") statusCode = event.statusCode
        entry.statusCode = statusCode
        if (index !== -1) removed = { id: event.ctx.id, index }
        let error: string | undefined
        if (event.kind === "request.failed") error = event.error
        else if (event.kind === "request.aborted") error = "client disconnected"
        const historyEntry =
          (event as { entry?: HistoryEntryData }).entry ?? ({ id: event.ctx.id, endpoint: event.ctx.endpoint, state: outcome } as HistoryEntryData)
        effects.push({ kind: "terminal", entry, outcome, error, statusCode, historyEntry })
        break
      }
      default: {
        assertNever(event)
      }
    }

    return { previousIds, activeIds: this.orderedIds(), removed, effects }
  }

  clear(): void {
    this.entries.clear()
  }

  private upsert(ctx: RequestContextSnapshot): { entry: ActiveRequest; inserted: boolean } {
    const existing = this.entries.get(ctx.id)
    if (existing) {
      existing.ctx = ctx
      return { entry: existing, inserted: false }
    }
    const entry = newEntry(ctx)
    if (!isTerminalState(ctx.state)) this.entries.set(ctx.id, entry)
    return { entry, inserted: !isTerminalState(ctx.state) }
  }
}

function newEntry(ctx: RequestContextSnapshot): ActiveRequest {
  return { ctx, tags: [], isHistoryAccess: ctx.path.startsWith("/history"), attemptCount: 0, attempts: [] }
}

function mergeAttempt(entry: ActiveRequest, snapshot: AttemptSnapshot): void {
  const index = entry.attempts.findIndex((attempt) => attempt.attemptIndex === snapshot.attemptIndex)
  if (index === -1) entry.attempts.push(snapshot)
  else entry.attempts[index] = snapshot
}

function projectFeature(entry: ActiveRequest, feature: FeatureKind, detail?: Record<string, unknown>): void {
  if (feature === "thinking") {
    const effective = detail?.effective
    if (typeof effective !== "string") return
    const requested = typeof detail?.requested === "string" ? detail.requested : entry.thinking?.requested
    const sanitizedEffective = sanitizeTerminalText(effective)
    entry.thinking = { effective: sanitizedEffective }
    if (requested !== undefined) entry.thinking.requested = sanitizeTerminalText(requested)
    return
  }

  const tag = featureTag(feature, detail)
  if (tag && !entry.tags.includes(tag)) entry.tags.push(tag)
  if (feature !== "tool-call-recovered") return
  const tools = detail?.tools
  if (Array.isArray(tools))
    entry.recoveredToolNames = tools.filter((tool): tool is string => typeof tool === "string").map((tool) => sanitizeTerminalText(tool))
}

function featureTag(feature: Exclude<FeatureKind, "thinking">, detail?: Record<string, unknown>): string | undefined {
  switch (feature) {
    case "stream-immediate-keepalive":
    case "stream-upstream-resolved": {
      return undefined
    }
    case "beta-stripped": {
      const values = safeStringArray(detail?.betas)
      return values.length > 0 ? `beta-strip:${values.join(",")}` : feature
    }
    case "cache-control-stripped": {
      const values = safeStringArray(detail?.fields)
      return values.length > 0 ? `cc-strip:${values.join(",")}` : feature
    }
    case "transport": {
      if (detail?.kind === "upstream-ws") return "ws"
      if (detail?.kind === "upstream-ws-fallback") return "ws→http"
      return undefined
    }
    case "via-chat-completions-fallback":
    case "via-responses":
    case "dropped-params":
    case "tool-call-recovered":
    case "refusal-recovered":
    case "refusal-errored":
    case "refusal-passthrough":
    case "error-shaping-decided":
    case "error-shaping-auq-synthesized":
    case "error-shaping-selfheal-delegated":
    case "error-shaping-raw-canonical":
    case "tool-input-decode-failed":
    case "protect-streaming-retry":
    case "context-edits-applied":
    case "tool-input-repaired":
    case "tool-input-unrepairable":
    case "translated-content-filter": {
      return feature
    }
    default: {
      return assertNever(feature)
    }
  }
}

function safeStringArray(value: unknown): Array<string> {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => sanitizeTerminalText(item)) : []
}

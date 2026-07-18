import type { PreparedRequest } from "~/lib/pipeline/types"

const ANTHROPIC_SERVER_TOOL_PREFIXES = ["web_search_", "web_fetch_", "code_execution_", "tool_search_"] as const
const ANTHROPIC_CLIENT_TOOL_PREFIXES = ["text_editor_", "computer_", "bash_", "memory_"] as const
const RESPONSES_SERVER_TOOL_TYPES = new Set(["web_search", "file_search", "code_interpreter"])
const RESPONSES_CLIENT_TOOL_TYPES = new Set(["function", "custom"])

export type ServerExecutionRisk =
  | { readonly kind: "none" }
  | { readonly kind: "server-executed"; readonly toolType: string }
  | { readonly kind: "unknown-api-tool"; readonly toolType: string }

export interface HedgePolicyConfig {
  readonly enabled: boolean
  readonly thresholdMs: number
  readonly maxSecondaryCandidates: number
  readonly maxActiveCandidates: number
  readonly maxTotalCandidates: number
  readonly maxActiveDispatches: number
  readonly maxTotalDispatches: number
  readonly cleanupMarginMs: number
  /** Effective per-model timeout. Zero means disabled. */
  readonly responseHeaderTimeoutMs: number
  /** Absolute monotonic request deadline. Zero/undefined means disabled. */
  readonly requestDeadlineAtMs?: number
  /** Required when response-header timeout is disabled. */
  readonly expectedHedgeCompletionMs?: number
  readonly allowServerTools?: boolean
}

export interface HedgeEligibilityContext {
  readonly nowMs: number
  /** Monotonic instant immediately before the primary's first physical transport.open(). */
  readonly primaryDispatchedAtMs: number | undefined
  readonly wire: PreparedRequest
  readonly semanticContentCommitted: boolean
  /** Diagnostic only: synthetic scaffold is intentionally ignored by eligibility. */
  readonly syntheticScaffoldSent?: boolean
  readonly winnerSelected: boolean
  readonly cancelled: boolean
  readonly settled: boolean
  readonly secondaryCandidates: number
  readonly activeCandidates: number
  readonly totalCandidates: number
  readonly activeDispatches: number
  readonly totalDispatches: number
}

export type HedgeIneligibleReason =
  | "disabled"
  | "primary-not-dispatched"
  | "threshold-not-reached"
  | "semantic-content-committed"
  | "winner-selected"
  | "generation-cancelled"
  | "generation-settled"
  | "secondary-budget-exhausted"
  | "active-candidate-budget-exhausted"
  | "total-candidate-budget-exhausted"
  | "active-dispatch-budget-exhausted"
  | "total-dispatch-budget-exhausted"
  | "insufficient-deadline-budget"
  | "server-execution-risk"

export type HedgeEligibility =
  | {
      readonly eligible: true
      readonly reason?: undefined
      readonly thresholdAtMs: number
      readonly serverExecutionRisk: ServerExecutionRisk
    }
  | {
      readonly eligible: false
      readonly reason: HedgeIneligibleReason
      readonly thresholdAtMs?: number
      readonly serverExecutionRisk?: ServerExecutionRisk
    }

export interface FrozenHedgePolicy {
  readonly enabled: boolean
  readonly thresholdMs: number
  readonly expectedHedgeCompletionMs: number
  /** Absolute monotonic deadline; disabled deadlines are represented as positive Infinity. */
  readonly requestDeadlineAtMs: number
  evaluate(context: HedgeEligibilityContext): HedgeEligibility
}

/** Freeze generation-lifetime hedge policy values; later config mutations cannot affect it. */
export function createFrozenHedgePolicy(config: HedgePolicyConfig): FrozenHedgePolicy {
  const enabled = config.enabled
  const thresholdMs = nonnegativeFinite(config.thresholdMs, "thresholdMs")
  const cleanupMarginMs = nonnegativeFinite(config.cleanupMarginMs, "cleanupMarginMs")
  const maxSecondaryCandidates = nonnegativeInteger(config.maxSecondaryCandidates, "maxSecondaryCandidates")
  const maxActiveCandidates = nonnegativeInteger(config.maxActiveCandidates, "maxActiveCandidates")
  const maxTotalCandidates = nonnegativeInteger(config.maxTotalCandidates, "maxTotalCandidates")
  const maxActiveDispatches = nonnegativeInteger(config.maxActiveDispatches, "maxActiveDispatches")
  const maxTotalDispatches = nonnegativeInteger(config.maxTotalDispatches, "maxTotalDispatches")
  const requestDeadlineAtMs = disabledAsInfinity(config.requestDeadlineAtMs)
  const responseHeaderTimeoutMs = disabledAsInfinity(config.responseHeaderTimeoutMs)
  const expectedHedgeCompletionMs = config.expectedHedgeCompletionMs ?? responseHeaderTimeoutMs
  const allowServerTools = config.allowServerTools ?? false

  if (enabled && (!Number.isFinite(expectedHedgeCompletionMs) || expectedHedgeCompletionMs <= 0)) {
    throw new Error("[hedge-policy] enabled hedging requires a finite hedge completion budget")
  }
  if (config.expectedHedgeCompletionMs !== undefined && config.expectedHedgeCompletionMs <= 0) {
    throw new Error("[hedge-policy] expectedHedgeCompletionMs must be positive")
  }

  const evaluate = (context: HedgeEligibilityContext): HedgeEligibility => {
    if (!enabled) return { eligible: false, reason: "disabled" }
    if (context.primaryDispatchedAtMs === undefined) return { eligible: false, reason: "primary-not-dispatched" }
    const thresholdAtMs = context.primaryDispatchedAtMs + thresholdMs
    if (context.nowMs < thresholdAtMs) return { eligible: false, reason: "threshold-not-reached", thresholdAtMs }
    if (context.semanticContentCommitted) return { eligible: false, reason: "semantic-content-committed", thresholdAtMs }
    if (context.winnerSelected) return { eligible: false, reason: "winner-selected", thresholdAtMs }
    if (context.cancelled) return { eligible: false, reason: "generation-cancelled", thresholdAtMs }
    if (context.settled) return { eligible: false, reason: "generation-settled", thresholdAtMs }
    if (context.secondaryCandidates >= maxSecondaryCandidates) return { eligible: false, reason: "secondary-budget-exhausted", thresholdAtMs }
    if (context.activeCandidates >= maxActiveCandidates) return { eligible: false, reason: "active-candidate-budget-exhausted", thresholdAtMs }
    if (context.totalCandidates >= maxTotalCandidates) return { eligible: false, reason: "total-candidate-budget-exhausted", thresholdAtMs }
    if (context.activeDispatches >= maxActiveDispatches) return { eligible: false, reason: "active-dispatch-budget-exhausted", thresholdAtMs }
    if (context.totalDispatches >= maxTotalDispatches) return { eligible: false, reason: "total-dispatch-budget-exhausted", thresholdAtMs }
    if (context.nowMs + expectedHedgeCompletionMs + cleanupMarginMs >= requestDeadlineAtMs) {
      return { eligible: false, reason: "insufficient-deadline-budget", thresholdAtMs }
    }

    const serverExecutionRisk = classifyServerExecutionRisk(context.wire)
    if (serverExecutionRisk.kind !== "none" && !allowServerTools) {
      return { eligible: false, reason: "server-execution-risk", thresholdAtMs, serverExecutionRisk }
    }
    return { eligible: true, thresholdAtMs, serverExecutionRisk }
  }

  return Object.freeze({ enabled, thresholdMs, expectedHedgeCompletionMs, requestDeadlineAtMs, evaluate })
}

/** Classify duplicate remote-execution risk from the final target wire, never from client format. */
export function classifyServerExecutionRisk(wire: PreparedRequest): ServerExecutionRisk {
  const tools = (wire.body as { tools?: unknown } | undefined)?.tools
  if (!Array.isArray(tools)) return { kind: "none" }

  for (const candidate of tools) {
    if (!candidate || typeof candidate !== "object") continue
    const type = (candidate as { type?: unknown }).type
    if (typeof type !== "string") continue

    if (wire.url === "/v1/messages") {
      if (ANTHROPIC_SERVER_TOOL_PREFIXES.some((prefix) => type.startsWith(prefix))) return { kind: "server-executed", toolType: type }
      if (ANTHROPIC_CLIENT_TOOL_PREFIXES.some((prefix) => type.startsWith(prefix))) continue
      return { kind: "unknown-api-tool", toolType: type }
    }

    if (wire.url === "/responses" || wire.url === "ws:/responses") {
      if (RESPONSES_SERVER_TOOL_TYPES.has(type)) return { kind: "server-executed", toolType: type }
      if (RESPONSES_CLIENT_TOOL_TYPES.has(type)) continue
      return { kind: "unknown-api-tool", toolType: type }
    }

    if (wire.url === "/chat/completions") {
      if (type === "function") continue
      return { kind: "unknown-api-tool", toolType: type }
    }

    // A typed tool on a newly introduced target endpoint is API-defined but unclassified. Default
    // to risk rather than silently enabling duplicate remote execution on a future protocol leg.
    return { kind: "unknown-api-tool", toolType: type }
  }
  return { kind: "none" }
}

function disabledAsInfinity(value: number | undefined): number {
  if (value === undefined || value === 0) return Number.POSITIVE_INFINITY
  return nonnegativeFinite(value, "timeout")
}

function nonnegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`[hedge-policy] ${name} must be a finite nonnegative number`)
  return value
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`[hedge-policy] ${name} must be a nonnegative integer`)
  return value
}

import type { DownstreamDeliverySession } from "~/lib/pipeline/delivery/session"

import {
  //
  classifyError,
  isAbortError,
  type ApiErrorType,
} from "~/lib/error"
import { hasDeliveredSemanticContent } from "~/lib/pipeline/generation/semantic-content-gate"
import { classifyStreamError } from "~/lib/stream"

import {
  //
  classifyPostCommitAbort,
  type PostCommitAbortKind,
} from "./post-commit-error"

/** Failure classes visible at the post-commit pre-content recovery decision point. */
export type PreContentRecoveryFailure =
  | { kind: "http-error"; errorType: ApiErrorType }
  | { kind: "network-error" }
  | { kind: "abort"; abortKind: PostCommitAbortKind }

export interface PreContentRecoveryFailureInput {
  readonly error: unknown
  readonly clientAborted: boolean
  readonly lifecycleSignal?: AbortSignal
}

interface HedgeFailureMember {
  readonly error: unknown
  readonly source: "upstream-transport" | "codec-render"
}

/**
 * Stable structural contract shared with the generation coordinator without importing its concrete
 * AggregateError type: all candidate failures remain available on the aggregate for diagnostics.
 */
function readHedgeFailures(error: unknown): ReadonlyArray<HedgeFailureMember> | undefined {
  if (typeof error !== "object" || error === null || !("hedgeFailures" in error)) return undefined
  const failures = (error as { hedgeFailures?: unknown }).hedgeFailures
  if (!Array.isArray(failures)) return undefined
  if (
    !failures.every(
      (failure) =>
        typeof failure === "object" && failure !== null && "error" in failure && (failure.source === "upstream-transport" || failure.source === "codec-render"),
    )
  )
    return undefined
  return failures as ReadonlyArray<HedgeFailureMember>
}

/** Retryable upstream classifications accepted by B2. Every other HTTP taxonomy is an explicit no-replay boundary. */
export function classifyPreContentRecoveryFailure(input: PreContentRecoveryFailureInput): PreContentRecoveryFailure {
  return classifyPreContentRecoveryFailureInner(input, new Set())
}

function classifyPreContentRecoveryFailureInner(input: PreContentRecoveryFailureInput, seen: Set<unknown>): PreContentRecoveryFailure {
  const { error } = input
  const hedgeFailures = readHedgeFailures(error)
  if (hedgeFailures === undefined) return classifySinglePreContentRecoveryFailure(input)
  if (seen.has(error)) return { kind: "http-error", errorType: "bad_request" }
  seen.add(error)
  return classifyHedgeAggregate(hedgeFailures, input, seen)
}

function classifyHedgeAggregate(
  failures: ReadonlyArray<HedgeFailureMember>,
  input: PreContentRecoveryFailureInput,
  seen: Set<unknown>,
): PreContentRecoveryFailure {
  // An empty or malformed aggregation cannot prove an upstream-only retryable failure.
  if (failures.length === 0) return { kind: "http-error", errorType: "bad_request" }
  let firstRetryableHttp: PreContentRecoveryFailure | undefined
  let allNetwork = true
  for (const failure of failures) {
    // The source gate is independent of error wording or AggregateError.errors ordering.
    if (failure.source !== "upstream-transport") return { kind: "http-error", errorType: "bad_request" }
    const classified = classifyPreContentRecoveryFailureInner({ ...input, error: failure.error }, seen)
    if (classified.kind === "abort") return classified
    if (classified.kind === "network-error") continue
    allNetwork = false
    if (!isRetryablePreContentHttpError(classified.errorType)) return classified
    firstRetryableHttp ??= classified
  }
  if (allNetwork) return { kind: "network-error" }
  // Every member was a B2-allowed deterministic failure. Keep an HTTP taxonomy when one exists;
  // `AggregateError.errors` and `hedgeFailures` remain intact on the original error for diagnostics.
  return firstRetryableHttp ?? { kind: "http-error", errorType: "bad_request" }
}

function classifySinglePreContentRecoveryFailure(input: PreContentRecoveryFailureInput): PreContentRecoveryFailure {
  const { error, clientAborted, lifecycleSignal } = input
  switch (classifyStreamError(error)) {
    case "client-abort": {
      return { kind: "abort", abortKind: "client-abort" }
    }
    case "reaper-cancel": {
      return { kind: "abort", abortKind: "reaper-cancel" }
    }
    case "request-deadline": {
      return { kind: "abort", abortKind: "request-deadline" }
    }
    case "request-cancel": {
      return { kind: "abort", abortKind: "request-cancel" }
    }
    case "dispatch-cancel": {
      return { kind: "abort", abortKind: "dispatch-cancel" }
    }
    case "unknown-cancel": {
      return { kind: "abort", abortKind: "unknown-abort" }
    }
    case "idle-timeout": {
      return { kind: "abort", abortKind: "header-timeout" }
    }
    case "other": {
      break
    }
    default: {
      throw new Error("unreachable stream classification")
    }
  }
  if (error instanceof Error && isAbortError(error)) return { kind: "abort", abortKind: classifyPostCommitAbort(clientAborted, lifecycleSignal, error) }
  const classified = classifyError(error)
  return classified.type === "network_error" ? { kind: "network-error" } : { kind: "http-error", errorType: classified.type }
}

function isRetryablePreContentHttpError(errorType: ApiErrorType): boolean {
  switch (errorType) {
    case "server_error":
    case "upstream_rate_limited":
    case "rate_limited": {
      return true
    }
    case "network_error": {
      return false
    }
    case "payload_too_large":
    case "token_limit":
    case "content_filtered":
    case "quota_exceeded":
    case "auth_expired":
    case "aborted":
    case "bad_request": {
      return false
    }
    default: {
      errorType satisfies never
      return false
    }
  }
}

/** Inputs to the pure B2 pre-content recovery gate. */
export interface PreContentRecoveryGateInput {
  readonly failure: PreContentRecoveryFailure
  readonly session: Pick<DownstreamDeliverySession, "hasEmittedRealClientContent">
  readonly config: { readonly enabled: boolean }
}

/**
 * Whether one deterministic upstream failure may launch the single B2 fresh dispatch.
 *
 * Abort classifications are deliberately all excluded: client-abort has no reader, while reaper-cancel and
 * header-wait timeout may still represent legitimate unbounded upstream thinking. This is the user-owned
 * `never-false-kill-legit-thinking` constraint in the plan README Global Constraints; relaxing it requires a
 * new user ruling, not an implementation choice. The abort variant currently has no production constructor:
 * Task 4.3 option A keeps the gate after handler's returning abort branches; the variant remains a defensive
 * exhaustiveness anchor if that mount point is later reconsidered. HTTP status alone is insufficient: B2 only
 * accepts the existing retryable A taxonomy, with all bad-request/auth/quota/filter/payload/token-limit classes
 * fail-closed. Callers that cannot resolve the raw delivery session must fail closed before calling: missing one
 * rescue is less harmful than replaying content already delivered to the client.
 */
export function shouldAttemptPreContentRecovery(input: PreContentRecoveryGateInput): boolean {
  switch (input.failure.kind) {
    case "abort": {
      switch (input.failure.abortKind) {
        case "client-abort":
        case "header-timeout":
        case "request-deadline":
        case "reaper-cancel":
        case "request-cancel":
        case "dispatch-cancel":
        case "unknown-abort": {
          return false
        }
        default: {
          input.failure.abortKind satisfies never
          return false
        }
      }
    }
    case "http-error":
    case "network-error": {
      if (input.failure.kind === "http-error" && !isRetryablePreContentHttpError(input.failure.errorType)) return false
      // This runtime guard protects untyped callers even though the public type requires session. A direct
      // `!input.session` is intentional; no-unnecessary-condition assumes typed callers and is unhelpful here.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the rule trusts the type; this guard exists precisely to distrust untyped callers
      if (!input.session) return false
      if (!input.config.enabled) return false
      return !hasDeliveredSemanticContent(input.session)
    }
    default: {
      input.failure satisfies never
      return false
    }
  }
}

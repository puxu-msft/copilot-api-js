/**
 * Candidate-state fork contract for concurrent upstream generation branches.
 *
 * Generation-stable JSON values are snapshotted once. Every candidate receives
 * its own body, retry hints, and factories for opaque mutable supplies. The
 * helper refuses to share an opaque mutable holder when no candidate-local
 * factory was provided; it never pretends that closures can be deep-cloned.
 *
 * This module is inert until the generation coordinator adopts it.
 */

import type { BetaProbe } from "~/lib/anthropic/pipeline"
import type { CandidateRole } from "~/lib/context/model-operation-record"
import type { PrepareHints } from "~/lib/request/retry-types"

import type { RequestEnvelope } from "../envelope"
import type { RequestState } from "../request-state"

// CandidateRole ("primary" | "hedge" | "recovery" | "continuation") is sourced from the operation-record
// SSOT — do NOT re-declare the literal union here (spec 2026-07-22; SSOT-types).

/** Candidate-local state produced from one frozen generation snapshot. */
export interface CandidateStateFork {
  readonly candidateId: string
  readonly role: CandidateRole
  readonly body: unknown
  readonly prepareHints: PrepareHints
  readonly requestState?: RequestState
  readonly responseState?: unknown
}

/** Factories required for opaque mutable values that cannot be honestly cloned. */
export interface CandidateStateSupplies {
  readonly createBetaProbe?: (clientAnthropicBeta: string | undefined) => BetaProbe
  readonly createReverseMapperHolder?: (source: unknown) => unknown
  readonly createResponsesFallbackScratch?: (source: unknown) => unknown
  readonly createResanitize?: (input: {
    source: NonNullable<RequestState["resanitize"]>
    reverseMapperHolder: unknown
  }) => NonNullable<RequestState["resanitize"]>
  readonly createResponseState?: () => unknown
}

/** Forks isolated candidate state from one immutable generation snapshot. */
export interface CandidateStateFactory {
  fork(input: { candidateId: string; role: CandidateRole }): CandidateStateFork
}

/**
 * Build a candidate-state factory and snapshot every generation-stable JSON value immediately.
 * Throws when the source carries an opaque mutable supply without its candidate-local factory.
 */
export function createCandidateStateFactory(env: RequestEnvelope, supplies: CandidateStateSupplies): CandidateStateFactory {
  const source = env.requestState
  validateOpaqueFactories(source, supplies)

  const generationBody = cloneAndFreeze(env.body, "body")
  const generationPrepareHints = cloneValue(env.prepareHints, "prepareHints")
  const stableState = snapshotStableState(source)

  return {
    fork({ candidateId, role }) {
      const reverseMapperHolder = source?.reverseMapperHolder === undefined ? undefined : supplies.createReverseMapperHolder?.(source.reverseMapperHolder)
      const requestState =
        source === undefined ? undefined : (
          Object.freeze({
            ...stableState,
            ...(source.betaProbe === undefined ? {} : { betaProbe: supplies.createBetaProbe?.(source.clientAnthropicBeta) }),
            ...(source.reverseMapperHolder === undefined ? {} : { reverseMapperHolder }),
            ...(source.responsesFallbackScratch === undefined ?
              {}
            : { responsesFallbackScratch: supplies.createResponsesFallbackScratch?.(source.responsesFallbackScratch) }),
            ...(source.resanitize === undefined ? {} : { resanitize: supplies.createResanitize?.({ source: source.resanitize, reverseMapperHolder }) }),
          } satisfies RequestState)
        )

      return Object.freeze({
        candidateId,
        role,
        // RFC §3.5: the generation body is already a deep-frozen snapshot; every candidate shares
        // that immutable source and switches to a new body through its later copy-on-write env.
        body: generationBody,
        prepareHints: cloneValue(generationPrepareHints, `candidate ${candidateId} prepareHints`),
        ...(requestState && { requestState }),
        ...(supplies.createResponseState && { responseState: supplies.createResponseState() }),
      })
    },
  }
}

function validateOpaqueFactories(source: RequestState | undefined, supplies: CandidateStateSupplies): void {
  if (source?.betaProbe !== undefined && !supplies.createBetaProbe) throw new Error("[candidate-state] createBetaProbe is required for source betaProbe")
  if (source?.reverseMapperHolder !== undefined && !supplies.createReverseMapperHolder) {
    throw new Error("[candidate-state] createReverseMapperHolder is required for source reverseMapperHolder")
  }
  if (source?.responsesFallbackScratch !== undefined && !supplies.createResponsesFallbackScratch) {
    throw new Error("[candidate-state] createResponsesFallbackScratch is required for source responsesFallbackScratch")
  }
  if (source?.resanitize !== undefined && !supplies.createResanitize) throw new Error("[candidate-state] createResanitize is required for source resanitize")
}

function snapshotStableState(source: RequestState | undefined): RequestState | undefined {
  if (!source) return undefined
  return Object.freeze({
    ...(source.truncateBaseline === undefined ? {} : { truncateBaseline: cloneAndFreeze(source.truncateBaseline, "truncateBaseline") }),
    ...(source.clientAnthropicBeta === undefined ? {} : { clientAnthropicBeta: source.clientAnthropicBeta }),
    ...(source.clientRequestHeaders === undefined ? {} : { clientRequestHeaders: cloneAndFreeze(source.clientRequestHeaders, "clientRequestHeaders") }),
    ...(source.initialSanitizationInfo === undefined ?
      {}
    : { initialSanitizationInfo: cloneAndFreeze(source.initialSanitizationInfo, "initialSanitizationInfo") }),
    ...(source.preprocessInfo === undefined ? {} : { preprocessInfo: cloneAndFreeze(source.preprocessInfo, "preprocessInfo") }),
    // Pure lookup object captured at parse; share by reference across candidates
    // so every retry/hedge composes target-wire provenance from the same client source.
    ...(source.sourceToolNameMapper === undefined ? {} : { sourceToolNameMapper: source.sourceToolNameMapper }),
  })
}

function cloneAndFreeze<T>(value: T, label: string): T {
  return deepFreeze(cloneValue(value, label))
}

function cloneValue<T>(value: T, label: string): T {
  try {
    return structuredClone(value)
  } catch (error) {
    throw new Error(`[candidate-state] ${label} must be structured-cloneable`, { cause: error })
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const child of Object.values(object)) deepFreeze(child, seen)
  Object.freeze(object)
  return value
}

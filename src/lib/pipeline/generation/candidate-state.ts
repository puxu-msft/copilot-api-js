/**
 * Candidate-state fork contract for concurrent upstream generation branches.
 *
 * Every candidate receives its own body, retry hints, and freshly built opaque mutable supplies. The helper refuses to fork when the source carries an opaque holder without a candidate-local factory; it never pretends that closures can be deep-cloned.
 *
 * Why per-candidate copies rather than one shared snapshot: the envelope scopes are mutable (see `../envelope`), so two candidates racing on one `attempt` object would overwrite each other's body mid-flight. The `request` scope is deliberately NOT copied — it is request-level truth, identical for every candidate by definition, and sharing it by reference is what makes a late write (gemini's S1b `truncateBaseline`) visible to siblings as intended.
 */

import type { CandidateRole } from "~/lib/context/model-operation-record"
import type { PrepareHints } from "~/lib/request/retry-types"

import type {
  //
  CandidateScope,
  RequestEnvelope,
} from "../envelope"

// CandidateRole ("primary" | "hedge" | "recovery" | "continuation") is sourced from the operation-record SSOT — do NOT re-declare the literal union here (spec 2026-07-22; SSOT-types).

/** Candidate-local state produced from one generation snapshot. */
export interface CandidateStateFork {
  readonly candidateId: string
  readonly role: CandidateRole
  readonly body: unknown
  readonly prepareHints: PrepareHints
  /** This candidate's own opaque mutable supplies — never shared with a sibling. */
  readonly candidate: CandidateScope
}

/** Factories required for opaque mutable values that cannot be honestly cloned. */
export interface CandidateStateSupplies {
  readonly createBetaProbe?: (clientAnthropicBeta: string | undefined) => CandidateScope["betaProbe"]
  readonly createReverseMapperHolder?: (source: unknown) => unknown
  readonly createResponsesFallbackScratch?: (source: unknown) => unknown
  readonly createResanitize?: (input: {
    source: NonNullable<CandidateScope["resanitize"]>
    reverseMapperHolder: unknown
  }) => NonNullable<CandidateScope["resanitize"]>
}

/** Forks isolated candidate state from one generation snapshot. */
export interface CandidateStateFactory {
  fork(input: { candidateId: string; role: CandidateRole }): CandidateStateFork
}

/**
 * Build a candidate-state factory and snapshot the generation-stable JSON values immediately.
 * Throws when the source carries an opaque mutable supply without its candidate-local factory.
 */
export function createCandidateStateFactory(env: RequestEnvelope, supplies: CandidateStateSupplies): CandidateStateFactory {
  const source = env.candidate
  validateOpaqueFactories(source, supplies)

  const generationBody = cloneValue(env.attempt.body, "body")
  const generationPrepareHints = cloneValue(env.attempt.prepareHints, "prepareHints")

  return {
    fork({ candidateId, role }) {
      const reverseMapperHolder = source.reverseMapperHolder === undefined ? undefined : supplies.createReverseMapperHolder?.(source.reverseMapperHolder)
      const candidate: CandidateScope = {
        ...(source.betaProbe === undefined ? {} : { betaProbe: supplies.createBetaProbe?.(env.request.clientAnthropicBeta) }),
        ...(source.reverseMapperHolder === undefined ? {} : { reverseMapperHolder }),
        ...(source.responsesFallbackScratch === undefined ?
          {}
        : { responsesFallbackScratch: supplies.createResponsesFallbackScratch?.(source.responsesFallbackScratch) }),
        ...(source.resanitize === undefined ? {} : { resanitize: supplies.createResanitize?.({ source: source.resanitize, reverseMapperHolder }) }),
      }

      return {
        candidateId,
        role,
        // Each candidate gets its OWN copy. The pre-mutability version shared one deep-frozen body across candidates and let copy-on-write keep them apart; with mutable scopes that sharing IS the aliasing this fork exists to prevent.
        body: cloneValue(generationBody, `candidate ${candidateId} body`),
        prepareHints: cloneValue(generationPrepareHints, `candidate ${candidateId} prepareHints`),
        candidate,
      }
    },
  }
}

function validateOpaqueFactories(source: CandidateScope, supplies: CandidateStateSupplies): void {
  if (source.betaProbe !== undefined && !supplies.createBetaProbe) throw new Error("[candidate-state] createBetaProbe is required for source betaProbe")
  if (source.reverseMapperHolder !== undefined && !supplies.createReverseMapperHolder) {
    throw new Error("[candidate-state] createReverseMapperHolder is required for source reverseMapperHolder")
  }
  if (source.responsesFallbackScratch !== undefined && !supplies.createResponsesFallbackScratch) {
    throw new Error("[candidate-state] createResponsesFallbackScratch is required for source responsesFallbackScratch")
  }
  if (source.resanitize !== undefined && !supplies.createResanitize) throw new Error("[candidate-state] createResanitize is required for source resanitize")
}

function cloneValue<T>(value: T, label: string): T {
  try {
    return structuredClone(value)
  } catch (error) {
    throw new Error(`[candidate-state] ${label} must be structured-cloneable`, { cause: error })
  }
}

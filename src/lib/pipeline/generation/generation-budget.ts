import type { CandidateRole } from "~/lib/context/model-operation-record"

export interface GenerationBudgetLimits {
  readonly maxActiveCandidates: number
  readonly maxTotalCandidates: number
  readonly maxActiveDispatches: number
  readonly maxTotalDispatches: number
}

export interface GenerationBudgetSnapshot {
  readonly activeCandidates: number
  readonly totalCandidates: number
  readonly activeDispatches: number
  readonly totalDispatches: number
}

export interface BudgetReservation {
  release(): void
}

export interface GenerationBudget {
  reserveCandidate(role: CandidateRole): BudgetReservation
  reserveDispatch(): BudgetReservation
  snapshot(): GenerationBudgetSnapshot
}

/** Generation-global active and lifetime resource budget shared by every candidate scheduler. */
export function createGenerationBudget(input: GenerationBudgetLimits): GenerationBudget {
  const limits = Object.freeze({
    maxActiveCandidates: positiveInteger(input.maxActiveCandidates, "maxActiveCandidates"),
    maxTotalCandidates: positiveInteger(input.maxTotalCandidates, "maxTotalCandidates"),
    maxActiveDispatches: positiveInteger(input.maxActiveDispatches, "maxActiveDispatches"),
    maxTotalDispatches: positiveInteger(input.maxTotalDispatches, "maxTotalDispatches"),
  })
  if (limits.maxTotalCandidates < limits.maxActiveCandidates) throw new Error("[generation-budget] total candidate budget must be >= active candidate budget")
  if (limits.maxTotalDispatches < limits.maxActiveDispatches) throw new Error("[generation-budget] total dispatch budget must be >= active dispatch budget")

  let activeCandidates = 0
  let totalCandidates = 0
  let activeDispatches = 0
  let totalDispatches = 0

  return {
    reserveCandidate(role) {
      if (totalCandidates >= limits.maxTotalCandidates) throw new Error(`[generation-budget] total candidate budget exhausted before ${role}`)
      if (activeCandidates >= limits.maxActiveCandidates) throw new Error(`[generation-budget] active candidate budget exhausted before ${role}`)
      totalCandidates++
      activeCandidates++
      return reservation(() => activeCandidates--)
    },

    reserveDispatch() {
      if (totalDispatches >= limits.maxTotalDispatches) throw new Error("[generation-budget] total dispatch budget exhausted")
      if (activeDispatches >= limits.maxActiveDispatches) throw new Error("[generation-budget] active dispatch budget exhausted")
      totalDispatches++
      activeDispatches++
      return reservation(() => activeDispatches--)
    },

    snapshot() {
      return Object.freeze({ activeCandidates, totalCandidates, activeDispatches, totalDispatches })
    },
  }
}

function reservation(onRelease: () => void): BudgetReservation {
  let released = false
  return {
    release() {
      if (released) return
      released = true
      onRelease()
    },
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`[generation-budget] ${name} must be a positive integer`)
  return value
}

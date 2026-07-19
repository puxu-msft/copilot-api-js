import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createGenerationBudget } from "~/lib/pipeline/generation/generation-budget"

describe("generation competition budget", () => {
  test("tracks active and total candidates independently", () => {
    const budget = createGenerationBudget({ maxActiveCandidates: 2, maxTotalCandidates: 3, maxActiveDispatches: 2, maxTotalDispatches: 4 })
    const primary = budget.reserveCandidate("primary")
    const hedge = budget.reserveCandidate("hedge")

    expect(budget.snapshot()).toMatchObject({ activeCandidates: 2, totalCandidates: 2 })
    expect(() => budget.reserveCandidate("recovery")).toThrow(/active candidate budget exhausted/i)
    hedge.release()
    const recovery = budget.reserveCandidate("recovery")
    expect(budget.snapshot()).toMatchObject({ activeCandidates: 2, totalCandidates: 3 })
    recovery.release()
    expect(() => budget.reserveCandidate("recovery")).toThrow(/total candidate budget exhausted/i)
    primary.release()
    expect(budget.snapshot().activeCandidates).toBe(0)
  })

  test("tracks dispatch reservations and releases active capacity", () => {
    const budget = createGenerationBudget({ maxActiveCandidates: 2, maxTotalCandidates: 3, maxActiveDispatches: 2, maxTotalDispatches: 3 })
    const first = budget.reserveDispatch()
    const second = budget.reserveDispatch()
    expect(budget.snapshot()).toMatchObject({ activeDispatches: 2, totalDispatches: 2 })
    expect(() => budget.reserveDispatch()).toThrow(/active dispatch budget exhausted/i)
    first.release()
    const third = budget.reserveDispatch()
    expect(budget.snapshot()).toMatchObject({ activeDispatches: 2, totalDispatches: 3 })
    second.release()
    third.release()
    expect(() => budget.reserveDispatch()).toThrow(/total dispatch budget exhausted/i)
  })

  test("reservations are idempotent and invalid limits fail fast", () => {
    const budget = createGenerationBudget({ maxActiveCandidates: 1, maxTotalCandidates: 1, maxActiveDispatches: 1, maxTotalDispatches: 1 })
    const candidate = budget.reserveCandidate("primary")
    candidate.release()
    candidate.release()
    expect(budget.snapshot().activeCandidates).toBe(0)
    expect(() => createGenerationBudget({ maxActiveCandidates: 2, maxTotalCandidates: 1, maxActiveDispatches: 1, maxTotalDispatches: 1 })).toThrow(
      /total candidate.*active candidate/i,
    )
  })
})

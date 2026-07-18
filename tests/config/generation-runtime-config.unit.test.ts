import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import { GenerationConfigSchema } from "~/lib/config/schema"
import { createRuntimeHedgePolicy } from "~/lib/pipeline/generation/runtime-policy"
import {
  //
  resetConfigManagedState,
  setGenerationRuntimeConfig,
  setTimeoutConfig,
  state,
} from "~/lib/state"

afterEach(() => resetConfigManagedState())

describe("generation runtime config", () => {
  test("parses the complete generation section", () => {
    const result = GenerationConfigSchema.safeParse({
      hedge: { enabled: true, threshold_sec: 300, max_secondary_candidates: 1, allow_server_tools: false },
      recovery: { max_candidates: 3 },
      max_active_candidates: 2,
      max_active_dispatches: 2,
      max_total_candidates: 5,
      max_total_dispatches: 16,
      cleanup_grace_sec: 10,
    })

    expect(result.success).toBe(true)
  })

  test("rejects zero active/total budgets", () => {
    expect(GenerationConfigSchema.safeParse({ max_active_candidates: 0 }).success).toBe(false)
    expect(GenerationConfigSchema.safeParse({ max_total_dispatches: 0 }).success).toBe(false)
  })

  test("freezes state into a per-request policy and leaves existing policies unchanged", () => {
    setGenerationRuntimeConfig({ generationHedgeEnabled: true, generationHedgeThresholdSec: 123, generationMaxTotalDispatches: 9 })
    const first = createRuntimeHedgePolicy("model", () => 1_000)
    setGenerationRuntimeConfig({ generationHedgeThresholdSec: 456, generationMaxTotalDispatches: 12 })
    const second = createRuntimeHedgePolicy("model", () => 2_000)

    expect(first.thresholdMs).toBe(123_000)
    expect(first.maxTotalDispatches).toBe(9)
    expect(second.thresholdMs).toBe(456_000)
    expect(second.maxTotalDispatches).toBe(12)
    expect(state.generationHedgeEnabled).toBe(true)
  })

  test("disables hedging for a request whose header and absolute deadlines are both disabled", () => {
    setGenerationRuntimeConfig({ generationHedgeEnabled: true })
    const originalHeaderTimeout = state.responseHeaderTimeout
    const originalDeadline = state.requestDeadline
    try {
      setTimeoutConfig({ responseHeaderTimeout: 0, requestDeadline: 0 })
      expect(createRuntimeHedgePolicy("model").enabled).toBe(false)
    } finally {
      setTimeoutConfig({ responseHeaderTimeout: originalHeaderTimeout, requestDeadline: originalDeadline })
    }
  })
})

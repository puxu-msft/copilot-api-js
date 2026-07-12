/**
 * Phase 1 (translation-matrix) — full-format retry-strategy builder registry (RFC §7.1,
 * W-strategies-builder). Verifies `assembleStrategiesForEndpoint` dispatches by the OUTBOUND leg
 * (`targetEndpoint`) off a route-codec-DECOUPLED supply, and equals the direct Anthropic build.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { MessagesPayload } from "~/types/api/anthropic"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { buildAnthropicStrategies } from "~/lib/codec/anthropic/strategies"
import { assembleStrategiesForEndpoint } from "~/lib/codec/strategy-registry"
import { ENDPOINT } from "~/lib/models/endpoint"

import { autoRestoreState } from "../helpers/state-fixture"

const baseline = { model: "claude-x", max_tokens: 8, messages: [] } as unknown as MessagesPayload
const stubResanitize = ((p: MessagesPayload) => ({ payload: p, stats: {} }) as unknown) as Parameters<typeof buildAnthropicStrategies>[0]["resanitize"]

const anthropicSupply = () => ({
  originalPayload: baseline,
  resanitize: stubResanitize,
  model: undefined,
  maxRetries: 5,
  betaProbe: createBetaProbe(undefined),
})

describe("strategy-registry — assembleStrategiesForEndpoint (RFC §7.1)", () => {
  autoRestoreState()

  test("/v1/messages leg → the Anthropic stack (same names as buildAnthropicStrategies)", () => {
    const viaRegistry = assembleStrategiesForEndpoint(ENDPOINT.MESSAGES, { anthropic: anthropicSupply() }).map((s) => s.name)
    const direct = buildAnthropicStrategies(anthropicSupply()).map((s) => s.name)
    expect(viaRegistry).toEqual(direct)
    // Sanity: the stack is non-trivial (14 strategies) and includes the auto-truncate tail.
    expect(viaRegistry.length).toBeGreaterThan(10)
    expect(viaRegistry).toContain("auto-truncate")
  })

  test("/v1/messages leg WITHOUT the anthropic supply → throws (wiring bug, not silent)", () => {
    expect(() => assembleStrategiesForEndpoint(ENDPOINT.MESSAGES, {})).toThrow(/anthropic supply/)
  })

  test("a leg with no builder yet (CC / Responses forward legs) → throws until Phase 2+", () => {
    expect(() => assembleStrategiesForEndpoint(ENDPOINT.CHAT_COMPLETIONS, { anthropic: anthropicSupply() })).toThrow(/no strategy builder/)
    expect(() => assembleStrategiesForEndpoint(ENDPOINT.RESPONSES, { anthropic: anthropicSupply() })).toThrow(/no strategy builder/)
  })
})

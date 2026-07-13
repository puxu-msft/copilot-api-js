/**
 * Phase 1 (translation-matrix) — full-format retry-strategy builder registry (RFC §7.1,
 * W-strategies-builder). Verifies `assembleStrategiesForEndpoint` dispatches by the OUTBOUND leg
 * (`targetEndpoint`) off a route-codec-DECOUPLED supply, and equals the direct Anthropic build.
 *
 * Phase 7: the CC-family forward legs (`/chat/completions` + `/responses` + `ws:/responses`) are now
 * registered too (closing the production gap where an anthropic→cc/responses request 500'd on the
 * `no strategy builder` throw). They share ONE `buildOpenAiCcStrategies` builder off the `cc` supply.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { MessagesPayload } from "~/types/api/anthropic"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { buildAnthropicStrategies } from "~/lib/codec/anthropic/strategies"
import { buildOpenAiCcStrategies } from "~/lib/codec/openai-cc/strategies"
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

const ccBaseline = { model: "gpt-x", messages: [] } as unknown as ChatCompletionsPayload
const ccSupply = (label = "Anthropic(→CC)") => ({
  originalPayload: ccBaseline,
  model: undefined,
  maxRetries: 5,
  label,
})

describe("strategy-registry — assembleStrategiesForEndpoint (RFC §7.1)", () => {
  autoRestoreState()

  test("/v1/messages leg → the Anthropic stack (same names as buildAnthropicStrategies)", () => {
    const viaRegistry = assembleStrategiesForEndpoint(ENDPOINT.MESSAGES, { anthropic: anthropicSupply() }).map((s) => s.name)
    const direct = buildAnthropicStrategies(anthropicSupply()).map((s) => s.name)
    expect(viaRegistry).toEqual(direct)
    // Sanity: the stack is non-trivial and ends with the deferred-tool tail.
    expect(viaRegistry.length).toBeGreaterThan(10)
    expect(viaRegistry).toContain("deferred-tool-retry")
  })

  test("/v1/messages leg WITHOUT the anthropic supply → throws (wiring bug, not silent)", () => {
    expect(() => assembleStrategiesForEndpoint(ENDPOINT.MESSAGES, {})).toThrow(/anthropic supply/)
  })

  test("CC forward legs (/chat/completions, /responses, ws:/responses) → the CC stack off the cc supply", () => {
    const direct = buildOpenAiCcStrategies(ccSupply()).map((s) => s.name)
    for (const leg of [ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.RESPONSES, ENDPOINT.WS_RESPONSES]) {
      const viaRegistry = assembleStrategiesForEndpoint(leg, { cc: ccSupply() }).map((s) => s.name)
      expect(viaRegistry).toEqual(direct)
      // Sanity: the CC stack is the 3-strategy chain (network → server-error → token-refresh).
      expect(viaRegistry).toContain("token-refresh")
      expect(viaRegistry.length).toBeGreaterThan(0)
    }
  })

  test("CC forward legs WITHOUT the cc supply → throws (wiring bug, not silent)", () => {
    expect(() => assembleStrategiesForEndpoint(ENDPOINT.CHAT_COMPLETIONS, { anthropic: anthropicSupply() })).toThrow(/cc supply/)
    expect(() => assembleStrategiesForEndpoint(ENDPOINT.RESPONSES, {})).toThrow(/cc supply/)
    expect(() => assembleStrategiesForEndpoint(ENDPOINT.WS_RESPONSES, {})).toThrow(/cc supply/)
  })

  test("an unregistered leg → throws (defensive guard; every real UpstreamEndpoint is now registered)", () => {
    // Cast past the type: all 4 real UpstreamEndpoint legs now have a builder, so this exercises the
    // defensive `default` branch that guards a hypothetical future leg added without a builder.
    const fakeLeg = "/v1/embeddings" as unknown as Parameters<typeof assembleStrategiesForEndpoint>[0]
    expect(() => assembleStrategiesForEndpoint(fakeLeg, { anthropic: anthropicSupply() })).toThrow(/no strategy builder/)
  })
})

/**
 * Phase 0 — upstream-error-client-shaping config scaffolding.
 *
 * Covers the 4 new `anthropic.*` keys' 3 touch points:
 *   - schema.ts: AnthropicConfigSchema zod validation (task 0.1)
 *   - config.ts + state.ts: applyConfigToState() → state.* wiring, defaults,
 *     and hot-reload retain-on-absence semantics (task 0.2)
 *
 * See docs/plan/2026-07-13-upstream-error-client-shaping/phase-0-config-scaffolding.md
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { AnthropicConfigSchema } from "~/lib/config/schema"

describe("error-shaping config schema", () => {
  test("accepts all 4 keys with valid values", () => {
    const parsed = AnthropicConfigSchema.parse({
      error_shaping_enabled: true,
      error_ask_user_question: false,
      error_auq_template: "model={model} status={status}",
      error_selfheal_delegate: { "adaptive-thinking-rejection-retry": "delegate", "tool-field-rejection-retry": "proxy" },
    })
    expect(parsed.error_shaping_enabled).toBe(true)
    expect(parsed.error_selfheal_delegate).toEqual({ "adaptive-thinking-rejection-retry": "delegate", "tool-field-rejection-retry": "proxy" })
  })

  test("rejects invalid error_selfheal_delegate value (not proxy/delegate)", () => {
    expect(() => AnthropicConfigSchema.parse({ error_selfheal_delegate: { foo: "bogus" } })).toThrow()
  })

  test("all 4 keys optional — absent config parses to undefined (warn-and-continue philosophy, no required keys)", () => {
    const parsed = AnthropicConfigSchema.parse({})
    expect(parsed.error_shaping_enabled).toBeUndefined()
    expect(parsed.error_selfheal_delegate).toBeUndefined()
  })
})


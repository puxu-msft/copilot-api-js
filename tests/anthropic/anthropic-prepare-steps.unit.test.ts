/**
 * P1.3 — guards the Anthropic prepare step-list ORDER contract. Byte-equivalence
 * of the produced wire+headers is covered by the comprehensive
 * anthropic-request-preparation.it.test.ts / coerce-adaptive-thinking.it.test.ts
 * suites (46 scenarios); this pins the named step sequence so a reorder/drop is
 * caught at the structural level (B3<B4<B5 = coerce<adjust<clamp; build-headers
 * last, since headers read the final wire body).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { MessagesPayload } from "~/types/api/anthropic"

import {
  //
  ANTHROPIC_PREPARE_STEPS,
  prepareAnthropicRequest,
  type PrepareStep,
} from "~/lib/anthropic/request-preparation"

describe("ANTHROPIC_PREPARE_STEPS order contract", () => {
  test("steps are named and ordered: coerce → adjust → clamp → strip-partner-features → rewrite-memory → cache → headers", () => {
    expect(ANTHROPIC_PREPARE_STEPS.map((s) => s.name)).toEqual([
      "coerce-thinking",
      "adjust-budget",
      "clamp-effort",
      "strip-partner-features",
      "rewrite-memory-tool",
      "cache-control",
      "build-headers",
    ])
  })

  test("thinking shape coercion precedes budget and effort clamping (B3<B4<B5)", () => {
    const names = ANTHROPIC_PREPARE_STEPS.map((s) => s.name)
    expect(names.indexOf("coerce-thinking")).toBeLessThan(names.indexOf("adjust-budget"))
    expect(names.indexOf("adjust-budget")).toBeLessThan(names.indexOf("clamp-effort"))
  })

  test("header build runs last — headers derive from the final wire body", () => {
    expect(ANTHROPIC_PREPARE_STEPS.at(-1)?.name).toBe("build-headers")
  })

  test("prepareAnthropicRequest actually iterates the step list in order (runner ↔ STEPS coupling)", () => {
    const calls: Array<string> = []
    const spySteps: ReadonlyArray<PrepareStep> = ANTHROPIC_PREPARE_STEPS.map((s) => ({
      name: s.name,
      apply: () => {
        calls.push(s.name)
      },
    }))
    const payload: MessagesPayload = { model: "claude-opus-4-6", max_tokens: 1024, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }
    prepareAnthropicRequest(payload, undefined, spySteps)
    expect(calls).toEqual([
      "coerce-thinking",
      "adjust-budget",
      "clamp-effort",
      "strip-partner-features",
      "rewrite-memory-tool",
      "cache-control",
      "build-headers",
    ])
  })
})

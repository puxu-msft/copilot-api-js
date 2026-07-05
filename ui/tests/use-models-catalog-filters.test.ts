import type { Model } from "~backend/lib/models/client"

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { matchesPolicyState, matchesPremium, matchesRestrictedTo } from "@/composables/useModelsCatalog"

const m = (over: Record<string, unknown> = {}): Model => ({ id: "m", name: "m", vendor: "v", object: "model", preview: false, model_picker_enabled: true, is_chat_default: false, is_chat_fallback: false, version: "1", billing: {}, ...over }) as Model

describe("model filter predicates", () => {
  test("matchesPremium filters by billing.is_premium; null = no filter", () => {
    expect(matchesPremium(m({ billing: { is_premium: true } }), true)).toBe(true)
    expect(matchesPremium(m({ billing: { is_premium: false } }), true)).toBe(false)
    expect(matchesPremium(m({ billing: { is_premium: false } }), false)).toBe(true)
    expect(matchesPremium(m(), null)).toBe(true)
  })

  test("matchesRestrictedTo requires overlap with selected plans; empty = no filter", () => {
    expect(matchesRestrictedTo(m({ billing: { restricted_to: ["pro", "business"] } }), ["business"])).toBe(true)
    expect(matchesRestrictedTo(m({ billing: { restricted_to: ["pro"] } }), ["enterprise"])).toBe(false)
    expect(matchesRestrictedTo(m(), [])).toBe(true)
    expect(matchesRestrictedTo(m(), ["pro"])).toBe(false)
  })

  test("matchesPolicyState filters by policy.state; null = no filter", () => {
    expect(matchesPolicyState(m({ policy: { state: "enabled", terms: "" } }), "enabled")).toBe(true)
    expect(matchesPolicyState(m({ policy: { state: "enabled", terms: "" } }), "disabled")).toBe(false)
    expect(matchesPolicyState(m(), null)).toBe(true)
    expect(matchesPolicyState(m(), "enabled")).toBe(false)
  })
})

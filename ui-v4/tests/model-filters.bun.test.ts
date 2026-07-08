import type { Model } from "~backend/lib/models/client"

import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import {
  //
  EMPTY_FILTERS,
  filterModels,
  matchesEndpoint,
  matchesPolicyState,
  matchesPremium,
  matchesRestrictedTo,
} from "@/lib/model-filters"

const m = (over: Record<string, unknown> = {}): Model =>
  ({
    id: "m",
    name: "m",
    vendor: "v",
    object: "model",
    preview: false,
    model_picker_enabled: true,
    is_chat_default: false,
    is_chat_fallback: false,
    version: "1",
    billing: {},
    ...over,
  }) as Model

const never = () => false

describe("model filter predicates", () => {
  it("matchesPremium: null = no filter", () => {
    expect(matchesPremium(m({ billing: { is_premium: true } }), true)).toBe(true)
    expect(matchesPremium(m({ billing: { is_premium: false } }), true)).toBe(false)
    expect(matchesPremium(m(), null)).toBe(true)
  })
  it("matchesRestrictedTo: empty = no filter, else overlap", () => {
    expect(matchesRestrictedTo(m({ billing: { restricted_to: ["pro", "business"] } }), ["business"])).toBe(true)
    expect(matchesRestrictedTo(m({ billing: { restricted_to: ["pro"] } }), ["enterprise"])).toBe(false)
    expect(matchesRestrictedTo(m(), [])).toBe(true)
  })
  it("matchesPolicyState: null = no filter, else exact", () => {
    expect(matchesPolicyState(m({ policy: { state: "enabled", terms: "" } }), "enabled")).toBe(true)
    expect(matchesPolicyState(m(), "enabled")).toBe(false)
    expect(matchesPolicyState(m(), null)).toBe(true)
  })
  it("matchesEndpoint: null = any", () => {
    expect(matchesEndpoint(m({ supported_endpoints: ["/responses"] }), null)).toBe(true)
  })
  it("matchesEndpoint: explicit supported_endpoints", () => {
    expect(matchesEndpoint(m({ supported_endpoints: ["/responses"] }), "/responses")).toBe(true)
    expect(matchesEndpoint(m({ supported_endpoints: ["/responses"] }), "/chat/completions")).toBe(false)
  })
  it("matchesEndpoint: inferred from capabilities.type when supported_endpoints absent", () => {
    expect(matchesEndpoint(m({ capabilities: { type: "chat" } }), "/chat/completions")).toBe(true)
  })
})

describe("filterModels", () => {
  it("search matches id or name (case-insensitive)", () => {
    const list = [m({ id: "claude-opus-4.8" }), m({ id: "gpt-4o", name: "GPT-4o" })]
    expect(filterModels(list, { ...EMPTY_FILTERS, search: "OPUS" }, never).map((x) => x.id)).toEqual(["claude-opus-4.8"])
    expect(filterModels(list, { ...EMPTY_FILTERS, search: "gpt-4" }, never).map((x) => x.id)).toEqual(["gpt-4o"])
  })
  it("has-telemetry filter uses the membership fn", () => {
    const list = [m({ id: "a" }), m({ id: "b" })]
    const hasT = (id: string) => id === "a"
    expect(filterModels(list, { ...EMPTY_FILTERS, hasTelemetry: true }, hasT).map((x) => x.id)).toEqual(["a"])
    expect(filterModels(list, { ...EMPTY_FILTERS, hasTelemetry: false }, hasT).map((x) => x.id)).toEqual(["b"])
  })
  it("vendor + premium combine (AND)", () => {
    const list = [m({ id: "a", vendor: "Anthropic", billing: { is_premium: true } }), m({ id: "b", vendor: "Anthropic", billing: { is_premium: false } })]
    expect(filterModels(list, { ...EMPTY_FILTERS, vendor: "Anthropic", premium: true }, never).map((x) => x.id)).toEqual(["a"])
  })
})

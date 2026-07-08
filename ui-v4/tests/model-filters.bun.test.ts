import type { Model } from "~backend/lib/models/client"

import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import {
  //
  countActiveFilters,
  EMPTY_FILTERS,
  filterModels,
  matchesBilling,
  matchesEndpoint,
  matchesPolicyState,
  matchesPremium,
  matchesRestrictedTo,
  modelBillingBounds,
} from "@/lib/model-filters"
import { modelStatus } from "@/lib/model-status"

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

/** Curry a real `modelStatus` closure over a config-disabled id set. */
const statusFor = (set: Set<string>) => (model: Model) => modelStatus(model, set)
const allEnabled = statusFor(new Set())

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

describe("billing-rate filter", () => {
  it("matchesBilling: null = any", () => {
    expect(matchesBilling(m({ billing: { multiplier: 5 } as Model["billing"] }), null)).toBe(true)
  })
  it("matchesBilling: within range inclusive", () => {
    const model = m({ billing: { multiplier: 3 } as Model["billing"] })
    expect(matchesBilling(model, [1, 5])).toBe(true)
    expect(matchesBilling(model, [4, 5])).toBe(false)
  })
  it("matchesBilling: missing multiplier treated as 0 (aligns Vue) → excluded when min>0", () => {
    const model = m({})
    expect(matchesBilling(model, [0, 5])).toBe(true)
    expect(matchesBilling(model, [1, 5])).toBe(false)
  })
  it("modelBillingBounds: [min,max] over multipliers, missing=0", () => {
    expect(modelBillingBounds([m({ billing: { multiplier: 2 } as Model["billing"] }), m({ billing: { multiplier: 8 } as Model["billing"] }), m({})])).toEqual([
      0, 8,
    ])
  })
})

describe("filterModels", () => {
  it("search matches id or name (case-insensitive)", () => {
    const list = [m({ id: "claude-opus-4.8" }), m({ id: "gpt-4o", name: "GPT-4o" })]
    expect(filterModels(list, { ...EMPTY_FILTERS, search: "OPUS" }, never, allEnabled).map((x) => x.id)).toEqual(["claude-opus-4.8"])
    expect(filterModels(list, { ...EMPTY_FILTERS, search: "gpt-4" }, never, allEnabled).map((x) => x.id)).toEqual(["gpt-4o"])
  })
  it("has-telemetry filter uses the membership fn", () => {
    const list = [m({ id: "a" }), m({ id: "b" })]
    const hasT = (id: string) => id === "a"
    expect(filterModels(list, { ...EMPTY_FILTERS, hasTelemetry: true }, hasT, allEnabled).map((x) => x.id)).toEqual(["a"])
    expect(filterModels(list, { ...EMPTY_FILTERS, hasTelemetry: false }, hasT, allEnabled).map((x) => x.id)).toEqual(["b"])
  })
  it("vendor + premium combine (AND)", () => {
    const list = [m({ id: "a", vendor: "Anthropic", billing: { is_premium: true } }), m({ id: "b", vendor: "Anthropic", billing: { is_premium: false } })]
    expect(filterModels(list, { ...EMPTY_FILTERS, vendor: "Anthropic", premium: true }, never, allEnabled).map((x) => x.id)).toEqual(["a"])
  })
})

describe("filterModels: status inclusion (config-disabled / picker-disabled)", () => {
  it("includes both disabled kinds by default", () => {
    const models = [
      { id: "on", name: "on", model_picker_enabled: true },
      { id: "cfg", name: "cfg", model_picker_enabled: true },
      { id: "pk", name: "pk", model_picker_enabled: false },
    ] as unknown as Array<Model>
    const out = filterModels(models, EMPTY_FILTERS, () => false, statusFor(new Set(["cfg"])))
    expect(out.map((x) => x.id).sort()).toEqual(["cfg", "on", "pk"])
  })

  it("hides config-disabled when includeConfigDisabled=false", () => {
    const models = [
      { id: "on", name: "on", model_picker_enabled: true },
      { id: "cfg", name: "cfg", model_picker_enabled: true },
    ] as unknown as Array<Model>
    const out = filterModels(models, { ...EMPTY_FILTERS, includeConfigDisabled: false }, () => false, statusFor(new Set(["cfg"])))
    expect(out.map((x) => x.id)).toEqual(["on"])
  })

  it("hides picker-disabled when includePickerDisabled=false", () => {
    const models = [
      { id: "on", name: "on", model_picker_enabled: true },
      { id: "pk", name: "pk", model_picker_enabled: false },
    ] as unknown as Array<Model>
    const out = filterModels(models, { ...EMPTY_FILTERS, includePickerDisabled: false }, () => false, statusFor(new Set()))
    expect(out.map((x) => x.id)).toEqual(["on"])
  })
})

describe("countActiveFilters", () => {
  it("empty = 0", () => {
    expect(countActiveFilters(EMPTY_FILTERS, [0, 10])).toBe(0)
  })
  it("counts scalar + array dims", () => {
    expect(countActiveFilters({ ...EMPTY_FILTERS, search: "gpt", vendor: "openai", capabilities: ["vision"] }, [0, 10])).toBe(3)
  })
  it("blank search does not count", () => {
    expect(countActiveFilters({ ...EMPTY_FILTERS, search: "   " }, [0, 10])).toBe(0)
  })
  it("counts every remaining dimension", () => {
    expect(
      countActiveFilters(
        {
          ...EMPTY_FILTERS,
          type: "chat",
          endpoint: "/responses",
          policyState: "enabled",
          premium: true,
          hasTelemetry: false,
          restrictedTo: ["pro"],
        },
        [0, 10],
      ),
    ).toBe(6)
  })
  it("billingRange active only when narrower than bounds", () => {
    // full-span range → not counted (load-bearing invariant)
    expect(countActiveFilters({ ...EMPTY_FILTERS, billingRange: [0, 10] }, [0, 10])).toBe(0)
    // raised lower bound → counted
    expect(countActiveFilters({ ...EMPTY_FILTERS, billingRange: [2, 10] }, [0, 10])).toBe(1)
    // lowered upper bound → counted
    expect(countActiveFilters({ ...EMPTY_FILTERS, billingRange: [0, 8] }, [0, 10])).toBe(1)
  })
  it("counts each excluded status kind (deviation from default = active)", () => {
    expect(countActiveFilters({ ...EMPTY_FILTERS, includeConfigDisabled: false }, [0, 0])).toBe(1)
    expect(countActiveFilters({ ...EMPTY_FILTERS, includeConfigDisabled: false, includePickerDisabled: false }, [0, 0])).toBe(2)
  })
})

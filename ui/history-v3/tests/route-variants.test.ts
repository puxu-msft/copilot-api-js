import { describe, expect, test } from "bun:test"

import { getVariantSwitchPath, isVuetifyPath } from "../src/utils/route-variants"

describe("route variants", () => {
  test("treats /v/* routes as Vuetify routes", () => {
    expect(isVuetifyPath("/v/dashboard")).toBe(true)
    expect(isVuetifyPath("/dashboard")).toBe(false)
    expect(isVuetifyPath("/")).toBe(false)
  })

  test("maps root path to the default Vuetify dashboard route", () => {
    expect(getVariantSwitchPath("/")).toBe("/v/dashboard")
  })

  test("switches legacy routes to their Vuetify equivalents", () => {
    expect(getVariantSwitchPath("/history")).toBe("/v/history")
    expect(getVariantSwitchPath("/usage")).toBe("/v/usage")
  })

  test("switches Vuetify routes back to their legacy equivalents", () => {
    expect(getVariantSwitchPath("/v/logs")).toBe("/logs")
    expect(getVariantSwitchPath("/v/models")).toBe("/models")
  })

  test("hides the variant switch on /v/config because there is no legacy page", () => {
    expect(getVariantSwitchPath("/v/config")).toBeNull()
  })
})

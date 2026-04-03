import { describe, expect, test } from "bun:test"

import { resolveRouterBase } from "../src/utils/router-base"
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
    expect(getVariantSwitchPath("/history")).toBe("/v/activity")
    expect(getVariantSwitchPath("/usage")).toBe("/v/dashboard")
  })

  test("switches Vuetify routes back to their legacy equivalents", () => {
    expect(getVariantSwitchPath("/v/logs")).toBe("/logs")
    expect(getVariantSwitchPath("/v/models")).toBeNull()
    expect(getVariantSwitchPath("/v/usage")).toBeNull()
  })

  test("hides the variant switch on /v/config because there is no legacy page", () => {
    expect(getVariantSwitchPath("/v/config")).toBeNull()
  })

  test("resolves router base from Vite BASE_URL and falls back to root", () => {
    expect(resolveRouterBase("/ui/")).toBe("/ui/")
    expect(resolveRouterBase("/")).toBe("/")
    expect(resolveRouterBase("")).toBe("/")
  })
})

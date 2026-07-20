/**
 * partner-feature-strip: the single table (`PARTNER_FEATURE_STRIP_TARGETS`) and
 * the shared wire-strip primitive (`stripPartnerFeatureFromWire`) that drives
 * BOTH strip sites (the reactive rejection strategy and the prepare step).
 *
 * Only features with a KNOWN SAFE strip target live in the table. Today that is
 * exactly `structured_outputs → output_config.format`; adding a row is a data
 * change, not a logic change.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  PARTNER_FEATURE_STRIP_TARGETS,
  stripPartnerFeatureFromWire,
} from "~/lib/anthropic/partner-feature-strip"

describe("PARTNER_FEATURE_STRIP_TARGETS", () => {
  test("maps structured_outputs to the output_config.format strip target", () => {
    expect(PARTNER_FEATURE_STRIP_TARGETS.structured_outputs).toEqual({ path: "output_config.format" })
  })

  test("contains ONLY the empirically-known-safe feature (no speculative rows)", () => {
    expect(Object.keys(PARTNER_FEATURE_STRIP_TARGETS)).toEqual(["structured_outputs"])
  })
})

describe("stripPartnerFeatureFromWire", () => {
  test("structured_outputs strips output_config.format, keeping sibling effort", () => {
    const wire: Record<string, unknown> = {
      model: "claude-sonnet-4.6",
      output_config: { effort: "high", format: { type: "json_schema", schema: {} } },
    }
    const changed = stripPartnerFeatureFromWire(wire, "structured_outputs")
    expect(changed).toBe(true)
    expect(wire.output_config).toEqual({ effort: "high" })
  })

  test("structured_outputs drops output_config entirely when format was its only key", () => {
    const wire: Record<string, unknown> = {
      model: "claude-sonnet-4.6",
      output_config: { format: { type: "json_schema", schema: {} } },
    }
    const changed = stripPartnerFeatureFromWire(wire, "structured_outputs")
    expect(changed).toBe(true)
    expect(wire.output_config).toBeUndefined()
  })

  test("returns false (no change) when there is no output_config.format to strip", () => {
    const wire: Record<string, unknown> = { model: "claude-sonnet-4.6", output_config: { effort: "high" } }
    const changed = stripPartnerFeatureFromWire(wire, "structured_outputs")
    expect(changed).toBe(false)
    expect(wire.output_config).toEqual({ effort: "high" })
  })

  test("a feature NOT in the table returns false and changes nothing", () => {
    const wire: Record<string, unknown> = {
      model: "claude-sonnet-4.6",
      output_config: { effort: "high", format: { type: "json_schema", schema: {} } },
    }
    const changed = stripPartnerFeatureFromWire(wire, "extended_thinking")
    expect(changed).toBe(false)
    expect(wire.output_config).toEqual({ effort: "high", format: { type: "json_schema", schema: {} } })
  })
})

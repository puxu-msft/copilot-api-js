import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { Tool } from "~/types/api/anthropic"

import {
  //
  markAnthropicServerToolUnsupported,
  resetAnthropicFeatureNegotiationForTesting,
} from "~/lib/anthropic/feature-negotiation"
import { stripServerTools } from "~/lib/anthropic/message-tools"

import { autoRestoreState } from "../helpers/state-fixture"

autoRestoreState()

afterEach(async () => {
  await resetAnthropicFeatureNegotiationForTesting()
})

const fnTool: Tool = { name: "Read", input_schema: { type: "object" } }
const webSearch: Tool = { name: "web_search", type: "web_search_20250305" }
const webFetch: Tool = { name: "web_fetch", type: "web_fetch_20250910" }
const MODEL = "claude-3-5-sonnet"

describe("stripServerTools — two-source union (learned + hint)", () => {
  test("passes all tools through when no source strips", () => {
    expect(stripServerTools([fnTool, webSearch], MODEL)).toEqual([fnTool, webSearch])
  })

  test("source 1: learned cache strips only the learned type, leaving other server tools", () => {
    markAnthropicServerToolUnsupported(MODEL, "web_search_")
    // web_search_ stripped (learned); web_fetch_ survives (not learned)
    expect(stripServerTools([fnTool, webSearch, webFetch], MODEL)).toEqual([fnTool, webFetch])
  })

  test("source 1 is per-model — a different model is unaffected", () => {
    markAnthropicServerToolUnsupported(MODEL, "web_search_")
    expect(stripServerTools([fnTool, webSearch], "claude-other")).toEqual([fnTool, webSearch])
  })

  test("source 2: per-attempt excludeTypes hint strips the matching prefix", () => {
    expect(stripServerTools([fnTool, webSearch, webFetch], MODEL, ["web_search_"])).toEqual([fnTool, webFetch])
  })

  test("union: learned + hint combine", () => {
    markAnthropicServerToolUnsupported(MODEL, "web_search_")
    expect(stripServerTools([fnTool, webSearch, webFetch], MODEL, ["web_fetch_"])).toEqual([fnTool])
  })

  test("returns undefined when stripping empties the tools array", () => {
    expect(stripServerTools([webSearch], MODEL, ["web_search_"])).toBeUndefined()
  })

  test("returns undefined for undefined input", () => {
    expect(stripServerTools(undefined, MODEL)).toBeUndefined()
  })
})

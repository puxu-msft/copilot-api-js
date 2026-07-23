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
  markAnthropicUnsupportedToolFields,
  resetAnthropicFeatureNegotiationForTesting,
} from "~/lib/anthropic/feature-negotiation"
import { stripToolFields } from "~/lib/anthropic/message-tools"
import { prepareAnthropicRequest } from "~/lib/anthropic/request-preparation"
import { setStateForTests } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

autoRestoreState()

afterEach(async () => {
  await resetAnthropicFeatureNegotiationForTesting()
})

const MODEL = "claude-haiku-4.5"

/** A custom tool carrying the client-side `eager_input_streaming` hint. */
function eagerTool(name = "Read"): Tool {
  return { name, description: "d", input_schema: { type: "object" }, eager_input_streaming: true }
}

describe("stripToolFields — source union minus guards", () => {
  test("built-in default strips eager_input_streaming, preserving other keys", () => {
    const out = stripToolFields([eagerTool()], MODEL)
    expect(out).toEqual([{ name: "Read", description: "d", input_schema: { type: "object" } }])
    expect(out![0].eager_input_streaming).toBeUndefined()
  })

  test("does not mutate the input tools", () => {
    const input = [eagerTool()]
    stripToolFields(input, MODEL)
    expect(input[0].eager_input_streaming).toBe(true)
  })

  test("config tool_strip_fields ADDS a field (union with built-in)", () => {
    setStateForTests({ stripToolFields: { "*": ["some_client_hint"] } })
    const tool = { name: "Read", input_schema: {}, eager_input_streaming: true, some_client_hint: 1 } as unknown as Tool
    const out = stripToolFields([tool], MODEL)
    expect(out).toEqual([{ name: "Read", input_schema: {} }])
  })

  test("endpoint-learned cache ADDS a field", () => {
    markAnthropicUnsupportedToolFields(["learned_field"])
    const tool = { name: "Read", input_schema: {}, learned_field: "x" } as unknown as Tool
    expect(stripToolFields([tool], MODEL)).toEqual([{ name: "Read", input_schema: {} }])
  })

  test("per-attempt excludeFields hint ADDS a field", () => {
    const tool = { name: "Read", input_schema: {}, attempt_field: true } as unknown as Tool
    expect(stripToolFields([tool], MODEL, ["attempt_field"])).toEqual([{ name: "Read", input_schema: {} }])
  })

  test("config tool_keep_fields SUBTRACTS — reversibility escape hatch un-strips the built-in", () => {
    setStateForTests({ keepToolFields: { "*": ["eager_input_streaming"] } })
    // eager kept → tool passes through unchanged
    expect(stripToolFields([eagerTool()], MODEL)![0].eager_input_streaming).toBe(true)
  })

  test("LEGIT_TOOL_KEYS are never stripped even if configured", () => {
    // An operator (mis)configures a legit key for stripping — the guard refuses.
    setStateForTests({ stripToolFields: { "*": ["input_schema", "name"] } })
    const out = stripToolFields([eagerTool()], MODEL)
    // eager still stripped (built-in) but name/input_schema survive.
    expect(out).toEqual([{ name: "Read", description: "d", input_schema: { type: "object" } }])
  })

  test("tool without any strippable field passes through unchanged", () => {
    setStateForTests({ keepToolFields: { "*": ["eager_input_streaming"] } })
    const plain: Tool = { name: "Read", input_schema: { type: "object" } }
    expect(stripToolFields([plain], MODEL)).toEqual([plain])
  })

  test("returns undefined for undefined input", () => {
    expect(stripToolFields(undefined, MODEL)).toBeUndefined()
  })
})

describe("prepareAnthropicRequest — end-to-end wire strip", () => {
  test("built-in default: a request with eager_input_streaming yields outbound tools without it (zero round-trip)", () => {
    const payload = {
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: "user" as const, content: "hi" }],
      tools: [eagerTool("Read"), eagerTool("Bash")],
    }
    const { wire } = prepareAnthropicRequest(payload)
    const tools = wire.tools as Array<Record<string, unknown>>
    expect(tools).toHaveLength(2)
    for (const tool of tools) expect(tool.eager_input_streaming).toBeUndefined()
    // Payload untouched (buildWirePayload deep-clones tools).
    expect(payload.tools[0].eager_input_streaming).toBe(true)
  })

  test("per-attempt excludeToolFields hint strips through the full prepare path", () => {
    const payload = {
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: "user" as const, content: "hi" }],
      tools: [{ name: "Read", input_schema: {}, future_hint: 1 } as unknown as Tool],
    }
    const { wire } = prepareAnthropicRequest(payload, { excludeToolFields: ["future_hint"] })
    const tools = wire.tools as Array<Record<string, unknown>>
    expect(tools[0].future_hint).toBeUndefined()
  })
})

describe("blast-radius: glob keys route through stripToolFields (spec 2026-07-23)", () => {
  test("glob strip key adds a field, glob keep key removes it", () => {
    setStateForTests({
      stripToolFields: { "claude-*": ["custom_field"] },
      keepToolFields: { "claude-opus-*": ["custom_field"] },
    })
    const tools = [{ name: "t", description: "d", input_schema: { type: "object" }, custom_field: 1 }] as unknown as Array<Tool>
    // opus matches BOTH: strip glob adds custom_field, keep glob removes it → field survives.
    const opus = stripToolFields(tools, "claude-opus-4.8") as unknown as Array<Record<string, unknown>>
    expect(opus[0]).toHaveProperty("custom_field")
    // sonnet matches ONLY the strip glob (not the opus keep) → field stripped.
    const sonnet = stripToolFields(tools, "claude-sonnet-4.6") as unknown as Array<Record<string, unknown>>
    expect(sonnet[0]).not.toHaveProperty("custom_field")
  })
})

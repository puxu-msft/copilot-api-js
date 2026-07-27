/**
 * L1 config for `anthropic.assistant_block_layout_strategy`.
 *
 * The key drives `repairAssistantBlockLayout()` (Task 1) via
 * `state.assistantBlockLayoutStrategy`. Here we only assert the schema layer:
 * the three enum values round-trip, invalid values are rejected, and an
 * absent key parses to `undefined` (the state default `move_blocks` is
 * supplied downstream by CONFIG_MANAGED_DEFAULTS, not the schema).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { AnthropicConfigSchema } from "~/lib/config/schema"

describe("assistant_block_layout_strategy config", () => {
  test("accepts the three enum values", () => {
    for (const v of ["passthrough", "insert_text", "move_blocks"] as const) {
      expect(AnthropicConfigSchema.parse({ assistant_block_layout_strategy: v }).assistant_block_layout_strategy).toBe(v)
    }
  })

  test("rejects an invalid value", () => {
    expect(() => AnthropicConfigSchema.parse({ assistant_block_layout_strategy: "nope" })).toThrow()
  })

  test("absent key parses to null (state default supplies move_blocks)", () => {
    expect(AnthropicConfigSchema.parse({}).assistant_block_layout_strategy ?? null).toBeNull()
  })
})

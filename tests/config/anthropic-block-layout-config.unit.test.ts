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
  test("accepts the two enum values", () => {
    for (const v of ["passthrough", "move_blocks"] as const) {
      expect(AnthropicConfigSchema.parse({ assistant_block_layout_strategy: v }).assistant_block_layout_strategy).toBe(v)
    }
  })

  test("rejects an invalid value", () => {
    expect(() => AnthropicConfigSchema.parse({ assistant_block_layout_strategy: "nope" })).toThrow()
  })

  // insert_text 已退役（它的契约「不移动真实块」与上游 C3「含 tool_use 必须以 tool_use 收尾」
  // 互斥，只能产出必被 400 的 payload）。schema 直接拒绝它——旧配置由 compat 层迁移，
  // 见 tests/config/config-compat.unit.test.ts。
  test("rejects the retired insert_text value（迁移由 compat 层负责，schema 不再认它）", () => {
    expect(() => AnthropicConfigSchema.parse({ assistant_block_layout_strategy: "insert_text" })).toThrow()
  })

  test("absent key parses to null (state default supplies move_blocks)", () => {
    expect(AnthropicConfigSchema.parse({}).assistant_block_layout_strategy ?? null).toBeNull()
  })
})

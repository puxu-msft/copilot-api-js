import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createAnthropicDeliveryProtocolAdapter } from "~/lib/pipeline/delivery/adapters/anthropic"

describe("delivery protocol adapters", () => {
  test("classifies an Anthropic content block start as the matching unit open", () => {
    const adapter = createAnthropicDeliveryProtocolAdapter()
    const frame = {
      event: "content_block_start",
      data: JSON.stringify({ type: "content_block_start", index: 7, content_block: { type: "text", text: "" } }),
    }

    expect(adapter.classify({ frame })).toEqual({
      kind: "unit-open",
      unit: { boundary: "content-block", key: "7" },
      frame,
    })
  })
})

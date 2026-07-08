import { expect, test } from "bun:test"

import { AnthropicConfigSchema } from "~/lib/config/schema"

test("stream_keepalive_mode accepts empty_text", () => {
  const parsed = AnthropicConfigSchema.parse({ stream_keepalive_mode: "empty_text" })
  expect(parsed.stream_keepalive_mode).toBe("empty_text")
})

test("default streamKeepaliveMode is empty_text", async () => {
  const { CONFIG_MANAGED_DEFAULTS } = await import("~/lib/state")
  expect(CONFIG_MANAGED_DEFAULTS.streamKeepaliveMode).toBe("empty_text")
})

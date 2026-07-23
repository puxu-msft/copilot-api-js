import {
  //
  expect,
  test,
} from "bun:test"

import { AnthropicConfigSchema } from "~/lib/config/schema"

// empty_text was RETIRED as the default (ADR 2026-07-22 D2) — wrong-shaped + G2-proven unable to reset
// CC's 300s deadline. The mode stays SELECTABLE (code kept dormant for keepalive research), so it must
// still parse; but the DEFAULT is now `ping`.

test("stream_keepalive_mode still accepts empty_text (dormant, selectable for research)", () => {
  const parsed = AnthropicConfigSchema.parse({ stream_keepalive_mode: "empty_text" })
  expect(parsed.stream_keepalive_mode).toBe("empty_text")
})

test("default streamKeepaliveMode is ping (empty_text retired — ADR 2026-07-22 D2)", async () => {
  const { CONFIG_MANAGED_DEFAULTS } = await import("~/lib/state")
  expect(CONFIG_MANAGED_DEFAULTS.streamKeepaliveMode).toBe("ping")
})

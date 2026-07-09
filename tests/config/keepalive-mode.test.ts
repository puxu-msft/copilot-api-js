import {
  //
  expect,
  test,
} from "bun:test"

import { AnthropicConfigSchema } from "~/lib/config/schema"

test("stream_keepalive_mode accepts enveloped_ping", () => {
  const r = AnthropicConfigSchema.safeParse({ stream_keepalive_mode: "enveloped_ping" })
  expect(r.success).toBe(true)
})

test("stream_keepalive_mode rejects removed content_delta at raw schema", () => {
  // content_delta is removed from the raw enum; the compat layer migrates the legacy value to
  // empty_text (Task 0.2), so the raw schema must reject it here.
  const r = AnthropicConfigSchema.safeParse({ stream_keepalive_mode: "content_delta" })
  expect(r.success).toBe(false)
})

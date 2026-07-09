import {
  //
  expect,
  test,
} from "bun:test"

import { AnthropicConfigSchema } from "~/lib/config/schema"
import { validateConfig } from "~/lib/config/validation"

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

test("content_delta migrates to empty_text via compat layer (Task 0.2)", () => {
  // Legacy config still carrying the removed content_delta value must be silently
  // migrated to empty_text (its unconditional-reset successor, no pre-response gating
  // difference) rather than stripped by the strict schema.
  const result = validateConfig({ anthropic: { stream_keepalive_mode: "content_delta" } })
  expect(result.anthropic?.stream_keepalive_mode).toBe("empty_text")
})

test("stream_keepalive_mode valid values pass through the compat layer unchanged", () => {
  for (const value of ["ping", "enveloped_ping", "empty_text"] as const) {
    const result = validateConfig({ anthropic: { stream_keepalive_mode: value } })
    expect(result.anthropic?.stream_keepalive_mode).toBe(value)
  }
})

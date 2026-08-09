import type { ServerSentEventMessage } from "fetch-event-stream"

import {
  //
  expect,
  test,
} from "bun:test"

import { assertAnthropicEventLineInvariant } from "./anthropic-sdk-oracle"

test("rejects an Anthropic frame without its event: line", () => {
  const frame = { data: JSON.stringify({ type: "message_start" }) } satisfies ServerSentEventMessage

  expect(() => assertAnthropicEventLineInvariant([frame])).toThrow("frame type=message_start must carry an event: line")
})

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

test("rejects a matching event: line that the Anthropic SDK does not recognize", () => {
  const frame = { event: "unknown_event", data: JSON.stringify({ type: "unknown_event" }) } satisfies ServerSentEventMessage

  expect(() => assertAnthropicEventLineInvariant([frame])).toThrow("event unknown_event must be SDK-recognized")
})

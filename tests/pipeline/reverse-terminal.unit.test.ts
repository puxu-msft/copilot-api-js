/**
 * Unit tests for the reverse-leg terminal-settle classifier (HIGH-1 / MEDIUM-1 review fix).
 *
 * Locks the three-state priority (upstream-error → truncated → complete) the three reverse pumps
 * (cc / responses / gemini) share, so a terminal Anthropic `error` frame is settled as the REAL
 * error (not misclassified as truncation, swallowing the cause + double-terminating the client),
 * and truncation is keyed on `sawMessageStop` (not the translator finish_reason).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createAnthropicStreamAccumulator } from "~/lib/anthropic/stream-accumulator"
import { classifyReverseAnthropicTerminal } from "~/lib/pipeline/reverse-terminal"

describe("classifyReverseAnthropicTerminal — reverse-leg terminal-settle priority", () => {
  test("terminal upstream error frame → upstream-error (real cause), NOT truncation (HIGH-1)", () => {
    // The H2 scenario: a terminal Anthropic `error` event was forwarded. The accumulator records the
    // real cause but sees NO message_stop — without the error gate this would misclassify as truncated.
    const acc = createAnthropicStreamAccumulator()
    acc.streamError = { type: "overloaded_error", message: "Overloaded" }
    // sawMessageStop stays false (an error frame is not a message_stop) — proves the error gate WINS.
    expect(acc.sawMessageStop).toBe(false)

    const terminal = classifyReverseAnthropicTerminal(acc)
    expect(terminal.kind).toBe("upstream-error")
    if (terminal.kind === "upstream-error") {
      expect(terminal.error.type).toBe("overloaded_error")
      expect(terminal.error.message).toBe("Overloaded")
    }
  })

  test("no message_stop, no error → truncated (F2, keyed on sawMessageStop)", () => {
    const acc = createAnthropicStreamAccumulator()
    // A message_delta stop_reason may have arrived (translator finishReason set) but the stream was
    // cut before message_stop — still a truncation. sawMessageStop is the authoritative signal.
    acc.stopReason = "end_turn" // simulate a message_delta that arrived
    expect(acc.sawMessageStop).toBe(false)

    expect(classifyReverseAnthropicTerminal(acc).kind).toBe("truncated")
  })

  test("complete message_stop with contentless refusal → contentless-refusal", () => {
    const acc = createAnthropicStreamAccumulator()
    acc.stopReason = "refusal"
    acc.contentBlocks = [{ type: "thinking", thinking: "", signature: "SIG" }]
    acc.sawMessageStop = true

    expect(classifyReverseAnthropicTerminal(acc).kind).toBe("contentless-refusal")
  })

  test("message_stop seen with client-visible refusal content → complete", () => {
    const acc = createAnthropicStreamAccumulator()
    acc.stopReason = "refusal"
    acc.contentBlocks = [{ type: "text", text: "I cannot help with that." }]
    acc.sawMessageStop = true

    expect(classifyReverseAnthropicTerminal(acc).kind).toBe("complete")
  })

  test("error gate wins even when message_stop WAS seen (error is highest priority)", () => {
    // Defensive: if an error frame AND a message_stop both arrived, the error still wins (a stream that
    // errored is a failure regardless of a trailing terminator).
    const acc = createAnthropicStreamAccumulator()
    acc.streamError = { type: "api_error", message: "boom" }
    acc.sawMessageStop = true

    expect(classifyReverseAnthropicTerminal(acc).kind).toBe("upstream-error")
  })
})

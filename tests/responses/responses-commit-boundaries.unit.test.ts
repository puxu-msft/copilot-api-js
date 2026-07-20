/**
 * Responses commit-boundary predicate (block-level buffered retry, spec §3.1 / §5.3).
 *
 * `isResponsesCommitBoundary(frame)` decides, per rendered Responses frame, whether it is a
 * "block complete, safe to flush up to (and including) here" boundary — the P2 implementation of
 * the driver's format-agnostic `commitBoundaries` opt. Boundaries = each output item's terminal
 * `response.output_item.done` (the Responses notion of a block) PLUS the three lifecycle terminals
 * (`response.completed/.failed/.incomplete`, which set `acc.status`) PLUS the in-band upstream
 * `error` frame (H2 — always a boundary, spec §5.3 M1). Every other event (created/in_progress/
 * output_item.added/*.delta/*.done-except-item/ping) is NOT a boundary.
 *
 * The predicate reads the frame's `event` line first (byte-mirrors the JSON `type` for every
 * compliant Responses frame — handler-v4.ts:328-330) and falls back to parsing `frame.data.type`;
 * an empty/unparseable frame is NOT a boundary (the driver skips it anyway).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { isResponsesCommitBoundary } from "~/lib/codec/openai-responses/commit-boundaries"

/** Build a Responses SSE-shaped ClientFrame (event line + JSON data carrying `type`). */
function frame(type: string, extra: Record<string, unknown> = {}): { event: string; data: string } {
  return { event: type, data: JSON.stringify({ type, ...extra }) }
}

describe("isResponsesCommitBoundary", () => {
  test("response.output_item.done IS a boundary (item-level block completion)", () => {
    expect(isResponsesCommitBoundary(frame("response.output_item.done", { output_index: 0, item: { type: "message" } }))).toBe(true)
  })

  test("all three lifecycle terminals ARE boundaries", () => {
    expect(isResponsesCommitBoundary(frame("response.completed"))).toBe(true)
    expect(isResponsesCommitBoundary(frame("response.failed"))).toBe(true)
    expect(isResponsesCommitBoundary(frame("response.incomplete"))).toBe(true)
  })

  test("in-band upstream error frame IS a boundary (H2, spec §5.3 M1)", () => {
    expect(isResponsesCommitBoundary(frame("error", { code: "server_error", message: "overloaded" }))).toBe(true)
  })

  test("non-terminal / intra-block events are NOT boundaries", () => {
    for (const t of [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.done", // text-part done ≠ item done — the ITEM may carry more parts
      "response.content_part.added",
      "response.content_part.done",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.ping", // the synthetic keepalive frame — NEVER a commit boundary
    ]) {
      expect(isResponsesCommitBoundary(frame(t))).toBe(false)
    }
  })

  test("falls back to parsing data.type when the event line is absent", () => {
    expect(isResponsesCommitBoundary({ data: JSON.stringify({ type: "response.output_item.done" }) })).toBe(true)
    expect(isResponsesCommitBoundary({ data: JSON.stringify({ type: "response.output_text.delta" }) })).toBe(false)
  })

  test("empty / unparseable / typeless frames are NOT boundaries", () => {
    expect(isResponsesCommitBoundary({ data: "" })).toBe(false)
    expect(isResponsesCommitBoundary({ event: "", data: "not json{" })).toBe(false)
    expect(isResponsesCommitBoundary({ data: JSON.stringify({ foo: 1 }) })).toBe(false)
  })
})

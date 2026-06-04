import { describe, expect, test } from "bun:test"

import { createStreamIdTracker, fixStreamEventIds } from "~/lib/openai/stream-id-sync"

describe("fixStreamEventIds", () => {
  test("returns data unchanged when event type is not handled", () => {
    const tracker = createStreamIdTracker()
    const data = JSON.stringify({ type: "response.created" })
    expect(fixStreamEventIds(data, "response.created", tracker)).toBe(data)
  })

  test("tracks canonical id from output_item.added and rewrites mismatched done event", () => {
    const tracker = createStreamIdTracker()

    const addedData = JSON.stringify({ output_index: 0, item: { id: "canonical_id" } })
    fixStreamEventIds(addedData, "response.output_item.added", tracker)

    const doneData = JSON.stringify({ output_index: 0, item: { id: "different_id" } })
    const corrected = fixStreamEventIds(doneData, "response.output_item.done", tracker)

    const parsed = JSON.parse(corrected) as { item: { id: string } }
    expect(parsed.item.id).toBe("canonical_id")
  })

  test("generates a stable id when added event is missing item.id", () => {
    const tracker = createStreamIdTracker()
    const addedData = JSON.stringify({ output_index: 3, item: {} })
    const out = fixStreamEventIds(addedData, "response.output_item.added", tracker)
    const parsed = JSON.parse(out) as { item: { id: string } }
    expect(parsed.item.id).toMatch(/^oi_3_/)
    expect(tracker.outputItems.get(3)).toBe(parsed.item.id)
  })

  test("returns original data on malformed JSON instead of throwing (best-effort)", () => {
    const tracker = createStreamIdTracker()
    const malformed = "{not valid json"

    // The contract: caller may sit outside an SSE parse try/catch. A SyntaxError
    // would otherwise tear down the entire downstream stream consumer.
    expect(() => fixStreamEventIds(malformed, "response.output_item.added", tracker)).not.toThrow()
    expect(fixStreamEventIds(malformed, "response.output_item.added", tracker)).toBe(malformed)
    expect(fixStreamEventIds(malformed, "response.output_item.done", tracker)).toBe(malformed)
    expect(fixStreamEventIds(malformed, "response.function_call_arguments.delta", tracker)).toBe(malformed)
  })
})

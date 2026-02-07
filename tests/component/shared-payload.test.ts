/**
 * Component tests for buildFinalPayload.
 *
 * Split from: characterization/shared-utils.test.ts
 * Tests: buildFinalPayload (calls sanitizeOpenAIMessages internally)
 */

import { describe, expect, test } from "bun:test"

import { buildFinalPayload } from "~/routes/shared"

describe("buildFinalPayload", () => {
  test("returns sanitized payload with null truncateResult", () => {
    const payload = {
      model: "gpt-4",
      messages: [{ role: "user" as const, content: "hello" }],
      stream: true,
    }

    const result = buildFinalPayload(payload, undefined)

    expect(result.truncateResult).toBeNull()
    expect(result.finalPayload).toBeDefined()
    expect(result.finalPayload.model).toBe("gpt-4")
  })

  test("preserves messages through sanitization", () => {
    const payload = {
      model: "gpt-4",
      messages: [
        { role: "user" as const, content: "hello" },
        { role: "assistant" as const, content: "hi" },
      ],
      stream: false,
    }

    const result = buildFinalPayload(payload, undefined)
    // Messages should be preserved (no orphans to remove)
    expect(result.finalPayload.messages.length).toBe(2)
    expect(result.sanitizeRemovedCount).toBe(0)
  })

  test("returns sanitizeRemovedCount and systemReminderRemovals", () => {
    const payload = {
      model: "gpt-4",
      messages: [{ role: "user" as const, content: "hello" }],
      stream: true,
    }

    const result = buildFinalPayload(payload, undefined)
    expect(typeof result.sanitizeRemovedCount).toBe("number")
    expect(typeof result.systemReminderRemovals).toBe("number")
  })
})

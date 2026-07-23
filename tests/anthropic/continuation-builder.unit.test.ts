/**
 * Unit tests for the Anthropic continuation-request builder + D3 gate predicate (spec 2026-07-22
 * §4.1/§4.3, ADR D3). Verifies the synthetic `[original] + [assistant=committed] + [user=message]`
 * assembly and the `hasCompleteInteractiveToolUse` turn-boundary gate.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { CanonicalBlock } from "~/lib/pipeline/committed-blocks-ledger"
import type { MessagesPayload } from "~/types/api/anthropic"

import {
  //
  buildAnthropicContinuationRequest,
  hasCompleteInteractiveToolUse,
} from "~/lib/anthropic/continuation-builder"
import {
  //
  getContinuationBuilder,
  registerContinuationBuilder,
} from "~/lib/pipeline/continuation-request-builder"

const original: MessagesPayload = {
  model: "claude-opus-4",
  max_tokens: 1024,
  messages: [{ role: "user", content: "write a plan" }],
  system: "you are helpful",
  stream: true,
}

describe("buildAnthropicContinuationRequest", () => {
  test("appends [assistant=committed blocks] + [user=message], original body otherwise unchanged", () => {
    const committed: Array<CanonicalBlock> = [
      { type: "text", text: "Here is the plan so far." },
      { type: "tool_use", id: "toolu_1", name: "Write", input: { path: "a.ts" } },
    ]
    const req = buildAnthropicContinuationRequest(original, committed, "network issue. please continue")

    // original scalar fields preserved (cache-friendly — body unchanged apart from the appended turns)
    expect(req.model).toBe("claude-opus-4")
    expect(req.max_tokens).toBe(1024)
    expect(req.system).toBe("you are helpful")
    expect(req.stream).toBe(true)

    // original user turn + synthetic assistant(committed) + synthetic user(message)
    expect(req.messages).toEqual([
      { role: "user", content: "write a plan" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Here is the plan so far." },
          { type: "tool_use", id: "toolu_1", name: "Write", input: { path: "a.ts" } },
        ],
      },
      { role: "user", content: "network issue. please continue" },
    ])
  })

  test("does not mutate the original payload's messages array", () => {
    const committed: Array<CanonicalBlock> = [{ type: "text", text: "x" }]
    const originalLen = original.messages.length
    buildAnthropicContinuationRequest(original, committed, "continue")
    expect(original.messages.length).toBe(originalLen) // spread, not push
  })

  test("empty committed prefix → just appends the user continuation turn with an empty assistant turn", () => {
    const req = buildAnthropicContinuationRequest(original, [], "continue")
    expect(req.messages.at(-2)).toEqual({ role: "assistant", content: [] })
    expect(req.messages.at(-1)).toEqual({ role: "user", content: "continue" })
  })
})

describe("hasCompleteInteractiveToolUse (ADR D3 gate)", () => {
  test("true when the committed prefix contains a tool_use block", () => {
    expect(
      hasCompleteInteractiveToolUse([
        { type: "text", text: "hi" },
        { type: "tool_use", id: "t", name: "R", input: {} },
      ]),
    ).toBe(true)
  })
  test("false for a text-only prefix (continuation may proceed)", () => {
    expect(
      hasCompleteInteractiveToolUse([
        { type: "text", text: "hi" },
        { type: "text", text: "more" },
      ]),
    ).toBe(false)
  })
  test("false for an empty prefix", () => {
    expect(hasCompleteInteractiveToolUse([])).toBe(false)
  })
})

describe("registry wiring", () => {
  test("registerAnthropicContinuationBuilder makes getContinuationBuilder('anthropic') resolve", async () => {
    const { registerAnthropicContinuationBuilder } = await import("~/lib/anthropic/continuation-builder")
    registerAnthropicContinuationBuilder()
    const builder = getContinuationBuilder("anthropic")
    expect(builder).toBeDefined()
    const out = builder?.(original, [{ type: "text", text: "hi" }], "continue") as MessagesPayload
    expect(out.messages.at(-1)).toEqual({ role: "user", content: "continue" })
  })

  test("gemini has no builder (continuation degrades to partial-degrade)", () => {
    // guard the negative: an unregistered format yields undefined (the driver then degrades)
    void registerContinuationBuilder // referenced so the import is used
    expect(getContinuationBuilder("gemini")).toBeUndefined()
  })
})

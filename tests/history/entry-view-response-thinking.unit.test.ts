/**
 * `responseThinkingFromBody` / `resolveResponseThinking` — derive the
 * response-side "did the model actually think" dimension from a stored upstream
 * response body.
 *
 * The signature-based three-way split is load-bearing and calibrated against
 * REAL 4141 data (empirical-verification): GHC strips the plaintext of opus
 * thinking blocks and leaves only a `signature`, so a `thinking: ""` block with a
 * signature is a LEGITIMATE encrypted thought — NOT poisoned. Only a plaintext-
 * empty, signature-less, non-redacted thinking block is the genuine
 * empty-plaintext poisoning case (see skill ghc-anthropic-upstream). A naive
 * "empty plaintext ⇒ poisoned" rule would misreport 100% of normal opus requests.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  resolveResponseThinking,
  responseThinkingFromBody,
} from "~/lib/history/entry-view"

describe("responseThinkingFromBody", () => {
  test("plaintext thinking → chars counted, hasSignature, not poisoned", () => {
    const body = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me reason about this", signature: "sig1" },
        { type: "text", text: "answer" },
      ],
    }
    expect(responseThinkingFromBody(body)).toEqual({
      blockCount: 1,
      chars: "let me reason about this".length,
      hasSignature: true,
      poisoned: false,
    })
  })

  test("GHC encrypted thinking (empty plaintext + signature) → not poisoned", () => {
    // The real opus wire shape: plaintext stripped, signature retained.
    const body = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "ErIECokBCA8YAipA" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "t1", name: "Bash", input: {} },
      ],
    }
    expect(responseThinkingFromBody(body)).toEqual({
      blockCount: 1,
      chars: 0,
      hasSignature: true,
      poisoned: false,
    })
  })

  test("empty plaintext AND no signature → poisoned", () => {
    const body = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "" }],
    }
    expect(responseThinkingFromBody(body)).toEqual({
      blockCount: 1,
      chars: 0,
      hasSignature: false,
      poisoned: true,
    })
  })

  test("whitespace-only plaintext without signature → poisoned (trimmed empty)", () => {
    const body = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "   \n  " }],
    }
    const r = responseThinkingFromBody(body)
    expect(r?.poisoned).toBe(true)
    expect(r?.hasSignature).toBe(false)
  })

  test("redacted_thinking → counted as a block, never poisoned, plaintext chars not counted", () => {
    const body = {
      role: "assistant",
      content: [{ type: "redacted_thinking", data: "encrypted-blob" }],
    }
    expect(responseThinkingFromBody(body)).toEqual({
      blockCount: 1,
      chars: 0,
      hasSignature: false,
      poisoned: false,
    })
  })

  test("multiple thinking blocks → blockCount and chars aggregate; signature on any block counts", () => {
    const body = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "aaa", signature: "s1" },
        { type: "thinking", thinking: "bb", signature: "s2" },
      ],
    }
    expect(responseThinkingFromBody(body)).toEqual({
      blockCount: 2,
      chars: 5,
      hasSignature: true,
      poisoned: false,
    })
  })

  test("mixed: one signed encrypted + one redacted → not poisoned, blockCount 2", () => {
    const body = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "s1" },
        { type: "redacted_thinking", data: "x" },
      ],
    }
    expect(responseThinkingFromBody(body)).toEqual({
      blockCount: 2,
      chars: 0,
      hasSignature: true,
      poisoned: false,
    })
  })

  test("poison is PER-BLOCK: a signed sibling never absolves a genuinely poisoned block", () => {
    // The reviewer-caught bug: a signed encrypted block must not hide a
    // double-empty (empty plaintext + empty signature) block. Verdict is per-block.
    const body = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "valid" }, // legitimate encrypted
        { type: "thinking", thinking: "" }, // genuine poison
      ],
    }
    expect(responseThinkingFromBody(body)).toEqual({
      blockCount: 2,
      chars: 0,
      hasSignature: true, // the signed sibling still surfaces
      poisoned: true, // ...but the poisoned block is NOT absolved
    })
  })

  test("whitespace-only signature is not a real seal → treated as unsigned (poison)", () => {
    // Mirrors the sanitizer's trimmed empty-field primitive: `signature: "   "`
    // is empty. An empty-plaintext block with only whitespace signature is poison.
    const body = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "", signature: "   " }],
    }
    const r = responseThinkingFromBody(body)
    expect(r?.hasSignature).toBe(false)
    expect(r?.poisoned).toBe(true)
  })

  test("a nonempty plaintext block spares only ITSELF, not a separate poison block", () => {
    const body = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "" }, // poison
        { type: "thinking", thinking: "real reasoning" }, // genuine
      ],
    }
    const r = responseThinkingFromBody(body)
    expect(r?.poisoned).toBe(true) // per-block: the empty unsigned block still poisons
    expect(r?.blockCount).toBe(2)
    expect(r?.chars).toBe("real reasoning".length)
  })

  test("no thinking blocks → undefined (dimension omitted)", () => {
    expect(responseThinkingFromBody({ role: "assistant", content: [{ type: "text", text: "hi" }] })).toBeUndefined()
    expect(responseThinkingFromBody({ role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] })).toBeUndefined()
  })

  test("string content / null / absent / nonsense bodies → undefined", () => {
    expect(responseThinkingFromBody({ role: "assistant", content: "plain string" })).toBeUndefined()
    expect(responseThinkingFromBody(null)).toBeUndefined()
    expect(responseThinkingFromBody(undefined)).toBeUndefined()
    expect(responseThinkingFromBody("nonsense")).toBeUndefined()
  })
})

describe("resolveResponseThinking (over the final attempt's upstreamResponse)", () => {
  test("reads the final attempt's response body", () => {
    const entry = {
      attempts: [
        { upstreamResponse: { success: false, body: { role: "assistant", content: [{ type: "thinking", thinking: "old" }] } } },
        { upstreamResponse: { success: true, body: { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }] } } },
      ],
    }
    // Cast: structural subset of HistoryEntry (only fields the resolver reads).
    expect(resolveResponseThinking(entry as never)).toEqual({ blockCount: 1, chars: 0, hasSignature: true, poisoned: false })
  })

  test("no attempts / no thinking → undefined", () => {
    expect(resolveResponseThinking({ attempts: [] } as never)).toBeUndefined()
    expect(resolveResponseThinking({} as never)).toBeUndefined()
    expect(
      resolveResponseThinking({
        attempts: [{ upstreamResponse: { success: true, body: { role: "assistant", content: [{ type: "text", text: "hi" }] } } }],
      } as never),
    ).toBeUndefined()
  })
})

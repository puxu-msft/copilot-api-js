import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { MessageParam } from "~/types/api/anthropic"

import { downgradeEmptyEncryptedSearchResults } from "~/lib/anthropic/sanitize/empty-encrypted-search-result"

/** Build an assistant message with the given content blocks. */
function assistant(content: Array<Record<string, unknown>>): MessageParam {
  return { role: "assistant", content } as unknown as MessageParam
}

/** Build a user message with the given content blocks. */
function user(content: Array<Record<string, unknown>>): MessageParam {
  return { role: "user", content } as unknown as MessageParam
}

type Block = { type: string } & Record<string, unknown>

function blocks(msg: MessageParam): Array<Block> {
  return msg.content as unknown as Array<Block>
}

/**
 * Canonical synthesized web_search assistant turn (mirrors synthesize.ts) with
 * the given per-result encrypted_content. Empty string is the poisoned shape.
 */
function webSearchAssistant(encrypted: string | undefined, id = "srvtoolu_abc"): MessageParam {
  const item: Record<string, unknown> = { type: "web_search_result", title: "R1", url: "https://example.com/1", page_age: null }
  if (encrypted !== undefined) item.encrypted_content = encrypted
  return assistant([
    { type: "server_tool_use", id, name: "web_search", input: { query: "anthropic tokenizer" } },
    { type: "web_search_tool_result", tool_use_id: id, content: [item] },
    { type: "text", text: "the answer" },
  ])
}

describe("downgradeEmptyEncryptedSearchResults — narrow-trigger fallback (always-on)", () => {
  test("downgrades a web_search turn whose result encrypted_content is empty string", () => {
    const messages = [user([{ type: "text", text: "search" }]), webSearchAssistant("")]
    const { messages: out, downgradedCount } = downgradeEmptyEncryptedSearchResults(messages)

    expect(downgradedCount).toBe(1)
    // user + assistant(tool_use+text) + user(tool_result)
    expect(out.length).toBe(3)
    expect(out[1].role).toBe("assistant")
    expect(blocks(out[1]).map((b) => b.type)).toEqual(["tool_use", "text"])
    expect(out[2].role).toBe("user")
    expect(blocks(out[2])[0].type).toBe("tool_result")
    // no web_search_tool_result / encrypted_content survives on the wire
    expect(JSON.stringify(out)).not.toContain("web_search_tool_result")
    expect(JSON.stringify(out)).not.toContain("encrypted_content")
  })

  test("downgrades when encrypted_content field is missing entirely (undefined)", () => {
    const { messages: out, downgradedCount } = downgradeEmptyEncryptedSearchResults([webSearchAssistant(undefined)])
    expect(downgradedCount).toBe(1)
    expect(JSON.stringify(out)).not.toContain("web_search_tool_result")
  })

  test("downgrades when encrypted_content is null (upstream: 'Input should be a valid string')", () => {
    // null is not undefined nor "" — a naive check would miss it. Upstream 400s
    // on it (exp/encrypted-content-400 CASE 4), so it must be caught.
    const msg = assistant([
      { type: "server_tool_use", id: "srvtoolu_null", name: "web_search", input: { query: "q" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_null",
        content: [{ type: "web_search_result", title: "R", url: "https://x", encrypted_content: null, page_age: null }],
      },
    ])
    const { messages: out, downgradedCount } = downgradeEmptyEncryptedSearchResults([msg])
    expect(downgradedCount).toBe(1)
    expect(JSON.stringify(out)).not.toContain("web_search_tool_result")
  })

  test("does NOT touch an error-shaped web_search_tool_result_error (upstream accepts it, HTTP 200)", () => {
    // Empirically upstream 200s on the error-shaped result (exp CASE 3), so
    // downgrading it would needlessly mutate an already-sendable turn.
    const input = [
      assistant([
        { type: "server_tool_use", id: "srvtoolu_es", name: "web_search", input: { query: "q" } },
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_es", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
      ]),
    ]
    const { messages: out, downgradedCount } = downgradeEmptyEncryptedSearchResults(input)
    expect(downgradedCount).toBe(0)
    expect(out).toBe(input) // identity no-op
    expect(JSON.stringify(out)).toContain("web_search_tool_result_error")
  })

  test("does NOT touch a web_search result with a real (non-empty) encrypted_content", () => {
    const messages = [webSearchAssistant("EhoKC3JlYWxfY2lwaGVy")]
    const { messages: out, downgradedCount } = downgradeEmptyEncryptedSearchResults(messages)
    expect(downgradedCount).toBe(0)
    // identity no-op: same reference, block still intact
    expect(out).toBe(messages)
    expect(JSON.stringify(out)).toContain("web_search_tool_result")
  })

  test("mixed: only the empty-encrypted turn is downgraded, a real one is left intact", () => {
    const messages = [webSearchAssistant("", "srvtoolu_bad"), webSearchAssistant("realcipher==", "srvtoolu_ok")]
    const { messages: out, downgradedCount } = downgradeEmptyEncryptedSearchResults(messages)
    expect(downgradedCount).toBe(1)
    // bad → split into 2 messages; ok → untouched → total 3
    expect(out.length).toBe(3)
    expect(JSON.stringify(out)).toContain("srvtoolu_ok") // real turn preserved
    // exactly one web_search_tool_result remains (the untouched real one)
    expect(JSON.stringify(out).match(/web_search_tool_result/g)?.length).toBe(1)
  })

  test("does NOT touch non-web-search server tool results (e.g. tool_search_tool_result)", () => {
    const msg = assistant([
      { type: "server_tool_use", id: "srvtoolu_ts", name: "tool_search", input: { query: "q" } },
      {
        type: "tool_search_tool_result",
        tool_use_id: "srvtoolu_ts",
        content: { type: "tool_search_tool_search_result", tool_references: [{ tool_name: "Bash" }] },
      },
    ])
    const input = [msg]
    const { messages: out, downgradedCount } = downgradeEmptyEncryptedSearchResults(input)
    expect(downgradedCount).toBe(0)
    expect(out).toBe(input) // untouched → identity no-op (same reference)
    expect(blocks(out[0]).map((b) => b.type)).toEqual(["server_tool_use", "tool_search_tool_result"])
  })

  test("plain messages without any server tool pass through untouched (same reference)", () => {
    const messages = [user([{ type: "text", text: "hi" }]), assistant([{ type: "text", text: "hello" }])]
    const { messages: out, downgradedCount } = downgradeEmptyEncryptedSearchResults(messages)
    expect(downgradedCount).toBe(0)
    expect(out).toBe(messages)
  })

  test("idempotent — running twice yields identical structure", () => {
    const first = downgradeEmptyEncryptedSearchResults([webSearchAssistant("")]).messages
    const second = downgradeEmptyEncryptedSearchResults(first).messages
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  test("string content messages are passed through", () => {
    const messages = [{ role: "user", content: "plain string" } as unknown as MessageParam]
    const { messages: out, downgradedCount } = downgradeEmptyEncryptedSearchResults(messages)
    expect(downgradedCount).toBe(0)
    expect(out).toBe(messages)
  })
})

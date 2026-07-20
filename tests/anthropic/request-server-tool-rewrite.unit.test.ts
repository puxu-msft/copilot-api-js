import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { MessageParam } from "~/types/api/anthropic"

import { rewriteServerToolBlocks } from "~/lib/anthropic/sanitize/rewrite-server-tool-blocks"
import { setStateForTests } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

autoRestoreState()

/** Build an assistant message with the given content blocks. */
function assistant(content: Array<Record<string, unknown>>): MessageParam {
  return { role: "assistant", content } as unknown as MessageParam
}

/** Build a user message with the given content blocks. */
function user(content: Array<Record<string, unknown>>): MessageParam {
  return { role: "user", content } as unknown as MessageParam
}

type Block = { type: string } & Record<string, unknown>

/** Narrow a message's content to a block array (tests always use array content). */
function blocks(msg: MessageParam): Array<Block> {
  return msg.content as unknown as Array<Block>
}

/** A canonical synthesized web_search assistant message (mirrors synthesize.ts). */
function webSearchAssistant(id = "srvtoolu_abc", query = "anthropic tokenizer", answer = "Here is the answer."): MessageParam {
  return assistant([
    { type: "server_tool_use", id, name: "web_search", input: { query } },
    {
      type: "web_search_tool_result",
      tool_use_id: id,
      content: [
        { type: "web_search_result", title: "Result One", url: "https://example.com/1", encrypted_content: "", page_age: null },
        { type: "web_search_result", title: "Result Two", url: "https://example.com/2", encrypted_content: "", page_age: null },
      ],
    },
    { type: "text", text: answer },
  ])
}

describe("rewriteServerToolBlocks — downgrade (message-splitting)", () => {
  test("splits a synthesized web_search assistant turn into assistant(tool_use+text) + user(tool_result)", () => {
    const messages = [user([{ type: "text", text: "search please" }]), webSearchAssistant("srvtoolu_abc", "anthropic tokenizer", "The answer.")]

    const { messages: out, rewroteCount } = rewriteServerToolBlocks(messages, "downgrade")

    expect(rewroteCount).toBe(1)
    // user (original) + assistant (tool_use+text) + user (tool_result) = 3
    expect(out.length).toBe(3)

    const asst = blocks(out[1])
    expect(out[1].role).toBe("assistant")
    expect(asst.map((b) => b.type)).toEqual(["tool_use", "text"])
    expect(asst[0]).toMatchObject({ type: "tool_use", id: "srvtoolu_abc", name: "web_search", input: { query: "anthropic tokenizer" } })

    const usr = blocks(out[2])
    expect(out[2].role).toBe("user")
    expect(usr.length).toBe(1)
    expect(usr[0].type).toBe("tool_result")
    expect(usr[0].tool_use_id).toBe("srvtoolu_abc")
    // Content carries the query prefix + result lines so the model recognizes a past search snapshot.
    expect(usr[0].content).toContain("anthropic tokenizer")
    expect(usr[0].content).toContain("Result One")
    expect(usr[0].content).toContain("https://example.com/1")
    expect(usr[0].content).toContain("Result Two")
  })

  test("no assistant message retains a tool_result after rewrite", () => {
    const { messages: out } = rewriteServerToolBlocks([webSearchAssistant()], "downgrade")
    for (const msg of out) {
      if (msg.role !== "assistant") continue
      for (const b of blocks(msg)) {
        expect(b.type).not.toBe("tool_result")
        expect(b.type).not.toBe("web_search_tool_result")
        expect(b.type).not.toBe("server_tool_use")
      }
    }
  })

  test("error-shaped result downgrades to tool_result with is_error=true", () => {
    const msg = assistant([
      { type: "server_tool_use", id: "srvtoolu_err", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_err", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
    ])
    const { messages: out } = rewriteServerToolBlocks([msg], "downgrade")

    const last = out.at(-1) as MessageParam
    const usr = blocks(last)
    expect(last.role).toBe("user")
    expect(usr[0].type).toBe("tool_result")
    expect(usr[0].is_error).toBe(true)
    expect(String(usr[0].content)).toContain("unavailable")
  })

  test("multiple server_tool_use pairs in one assistant collapse into one trailing user message", () => {
    const msg = assistant([
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q1" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [{ type: "web_search_result", title: "A", url: "https://a", encrypted_content: "", page_age: null }],
      },
      { type: "server_tool_use", id: "srvtoolu_2", name: "web_search", input: { query: "q2" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_2",
        content: [{ type: "web_search_result", title: "B", url: "https://b", encrypted_content: "", page_age: null }],
      },
      { type: "text", text: "done" },
    ])
    const { messages: out, rewroteCount } = rewriteServerToolBlocks([msg], "downgrade")

    expect(rewroteCount).toBe(2)
    expect(out.length).toBe(2)
    const asst = blocks(out[0])
    expect(asst.map((b) => b.type)).toEqual(["tool_use", "tool_use", "text"])
    const usr = blocks(out[1])
    expect(out[1].role).toBe("user")
    expect(usr.map((b) => b.type)).toEqual(["tool_result", "tool_result"])
    expect(usr[0].tool_use_id).toBe("srvtoolu_1")
    expect(usr[1].tool_use_id).toBe("srvtoolu_2")
  })

  test("matches by type, not name — web_fetch and code_execution are downgraded too", () => {
    const msg = assistant([
      { type: "server_tool_use", id: "srvtoolu_wf", name: "web_fetch", input: { url: "https://x" } },
      {
        type: "web_fetch_tool_result",
        tool_use_id: "srvtoolu_wf",
        content: [{ type: "web_search_result", title: "Fetched", url: "https://x", encrypted_content: "", page_age: null }],
      },
    ])
    const { messages: out, rewroteCount } = rewriteServerToolBlocks([msg], "downgrade")
    expect(rewroteCount).toBe(1)
    const asst = blocks(out[0])
    expect(asst[0]).toMatchObject({ type: "tool_use", id: "srvtoolu_wf", name: "web_fetch" })
    expect(out[1].role).toBe("user")
    expect(blocks(out[1])[0].type).toBe("tool_result")
  })
})

describe("rewriteServerToolBlocks — thinking protection (block-level, both policies downgrade)", () => {
  // Under the two-level policy model, `preserve` only protects thinking blocks at the
  // BLOCK level (don't mutate/drop/reorder them) — it does NOT freeze the whole message.
  // server_tool_use downgrade splits the turn so thinking + tool_use stay on assistant
  // and the *_tool_result moves to a new user message; thinking is echoed verbatim.
  // (`stripped` is identical for this pass — it also downgrades; the only difference is
  // that downstream strip passes may remove thinking, which doesn't happen in this test.)
  for (const policy of ["preserve", "stripped"] as const) {
    test(`DOES rewrite thinking+server_tool_use under policy=${policy}, thinking echoed verbatim`, () => {
      setStateForTests({ thinkingBlockMessagePolicy: policy })
      const thinkingBlock = { type: "thinking" as const, thinking: "reasoning", signature: "sig123" }
      const msg = assistant([
        thinkingBlock,
        { type: "server_tool_use", id: "srvtoolu_x", name: "web_search", input: { query: "q" } },
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_x",
          content: [{ type: "web_search_result", title: "T", url: "https://t", encrypted_content: "", page_age: null }],
        },
      ])
      const { messages: out, rewroteCount } = rewriteServerToolBlocks([msg], "downgrade")
      expect(rewroteCount).toBe(1)
      // thinking + tool_use stay on assistant; tool_result moves to a new user message.
      const asst = blocks(out[0])
      expect(asst.map((b) => b.type)).toEqual(["thinking", "tool_use"])
      // thinking echoed BYTE-FOR-BYTE (text + signature both untouched).
      expect(asst[0]).toEqual(thinkingBlock)
      expect(out[1].role).toBe("user")
      expect(blocks(out[1]).map((b) => b.type)).toEqual(["tool_result"])
    })
  }
})

describe("rewriteServerToolBlocks — passthrough & orphans", () => {
  test("mode=false is an identity no-op (same array reference)", () => {
    const messages = [webSearchAssistant()]
    const { messages: out, rewroteCount } = rewriteServerToolBlocks(messages, false)
    expect(rewroteCount).toBe(0)
    expect(out).toBe(messages)
  })

  test("orphan server_tool_use (no paired result) becomes tool_use, no fake result manufactured", () => {
    const msg = assistant([
      { type: "server_tool_use", id: "srvtoolu_orphan", name: "web_search", input: { query: "q" } },
      { type: "text", text: "hmm" },
    ])
    const { messages: out } = rewriteServerToolBlocks([msg], "downgrade")
    expect(out.length).toBe(1)
    const asst = blocks(out[0])
    expect(asst.map((b) => b.type)).toEqual(["tool_use", "text"])
  })

  test("orphan *_tool_result in a user message downgrades in place to tool_result", () => {
    const msg = user([
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_gone",
        content: [{ type: "web_search_result", title: "T", url: "https://t", encrypted_content: "", page_age: null }],
      },
    ])
    const { messages: out } = rewriteServerToolBlocks([msg], "downgrade")
    expect(out.length).toBe(1)
    expect(out[0].role).toBe("user")
    const b = blocks(out[0])[0]
    expect(b.type).toBe("tool_result")
    expect(b.tool_use_id).toBe("srvtoolu_gone")
  })

  test("server_tool_use with stringified input is preserved as-is on the tool_use", () => {
    const msg = assistant([
      { type: "server_tool_use", id: "srvtoolu_s", name: "web_search", input: JSON.stringify({ query: "q" }) },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_s",
        content: [{ type: "web_search_result", title: "T", url: "https://t", encrypted_content: "", page_age: null }],
      },
    ])
    const { messages: out } = rewriteServerToolBlocks([msg], "downgrade")
    const asst = blocks(out[0])
    // input passed through unchanged (parseStringifiedInput happens later in processToolBlocks)
    expect(asst[0].type).toBe("tool_use")
    expect(asst[0].input).toBe(JSON.stringify({ query: "q" }))
  })

  test("result content as a plain string is carried through", () => {
    const msg = assistant([
      { type: "server_tool_use", id: "srvtoolu_str", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_str", content: "raw textual result" },
    ])
    const { messages: out } = rewriteServerToolBlocks([msg], "downgrade")
    const usr = blocks(out.at(-1) as MessageParam)
    expect(usr[0].type).toBe("tool_result")
    expect(String(usr[0].content)).toContain("raw textual result")
  })

  test("idempotent — running twice yields the same structure", () => {
    const first = rewriteServerToolBlocks([webSearchAssistant()], "downgrade").messages
    const second = rewriteServerToolBlocks(first, "downgrade").messages
    expect(second.length).toBe(first.length)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  test("messages without server tools pass through untouched", () => {
    const messages = [user([{ type: "text", text: "hi" }]), assistant([{ type: "text", text: "hello" }])]
    const { messages: out, rewroteCount } = rewriteServerToolBlocks(messages, "downgrade")
    expect(rewroteCount).toBe(0)
    expect(out).toBe(messages)
  })
})

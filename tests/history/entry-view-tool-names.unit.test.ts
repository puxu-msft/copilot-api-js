/**
 * `toolNamesFromResponseBody` — extract invoked tool names from a stored
 * upstream response body, across the two shapes history persists:
 *   - Anthropic: `content[]` with `{ type: "tool_use" | "server_tool_use", name }` blocks
 *   - OpenAI Chat Completions / Responses: `tool_calls[].function.name`
 * Order is preserved and duplicates are kept (call count is meaningful).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  resolveResponseToolNames,
  toolNamesFromResponseBody,
} from "~/lib/history/entry-view"

describe("toolNamesFromResponseBody", () => {
  test("Anthropic content-block array → tool_use / server_tool_use names in order", () => {
    const body = {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "t1", name: "Bash", input: {} },
        { type: "thinking", thinking: "…" },
        { type: "tool_use", id: "t2", name: "Edit", input: {} },
        { type: "server_tool_use", id: "t3", name: "web_search", input: {} },
      ],
    }
    expect(toolNamesFromResponseBody(body)).toEqual(["Bash", "Edit", "web_search"])
  })

  test("OpenAI tool_calls array → function.name in order", () => {
    const body = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "Edit", arguments: "{}" } },
      ],
    }
    expect(toolNamesFromResponseBody(body)).toEqual(["Bash", "Edit"])
  })

  test("duplicates are preserved (not deduped)", () => {
    const body = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "t1", name: "Bash", input: {} },
        { type: "tool_use", id: "t2", name: "Bash", input: {} },
      ],
    }
    expect(toolNamesFromResponseBody(body)).toEqual(["Bash", "Bash"])
  })

  test("text-only Anthropic content and null/absent bodies → []", () => {
    expect(toolNamesFromResponseBody({ role: "assistant", content: [{ type: "text", text: "hi" }] })).toEqual([])
    expect(toolNamesFromResponseBody({ role: "assistant", content: "plain string" })).toEqual([])
    expect(toolNamesFromResponseBody(null)).toEqual([])
    expect(toolNamesFromResponseBody(undefined)).toEqual([])
    expect(toolNamesFromResponseBody("nonsense")).toEqual([])
  })
})

describe("resolveResponseToolNames (over the final attempt's upstreamResponse)", () => {
  test("reads the final attempt's response body", () => {
    const entry = {
      attempts: [
        { upstreamResponse: { success: true, body: { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "Old", input: {} }] } } },
        { upstreamResponse: { success: true, body: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } } },
      ],
    }
    // Cast: the test builds a structural subset of HistoryEntry (only the fields
    // the resolver reads); the resolver types on Pick<HistoryEntry, "attempts">.
    expect(resolveResponseToolNames(entry as never)).toEqual(["Bash"])
  })

  test("no attempts → []", () => {
    expect(resolveResponseToolNames({ attempts: [] } as never)).toEqual([])
    expect(resolveResponseToolNames({} as never)).toEqual([])
  })
})

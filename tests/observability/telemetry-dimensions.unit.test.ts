import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntryData } from "~/lib/context/types"

import {
  //
  CAPPED_DIMENSION_NAMES,
  extractTelemetryKeys,
  extractToolNames,
  normalizeClient,
} from "~/lib/observability/telemetry-dimensions"

/** Minimal settled-entry factory — only the fields the extractors read. */
function makeEntry(overrides: Partial<HistoryEntryData> = {}): HistoryEntryData {
  return {
    id: "req_1",
    endpoint: "anthropic-messages",
    startedAt: 0,
    endedAt: 1,
    state: "completed",
    active: false,
    lastUpdatedAt: 1,
    queueWaitMs: 0,
    attemptCount: 1,
    durationMs: 1,
    inboundRequest: { model: "claude-opus-4.8" },
    ...overrides,
  }
}

// A ctx snapshot isn't read by the current extractors; cast a stub.
const ctxStub = {} as never

describe("normalizeClient", () => {
  test("collapses a versioned user-agent to its leading product token (lowercased)", () => {
    expect(normalizeClient({ "user-agent": "claude-cli/1.2.3" })).toBe("claude-cli")
    expect(normalizeClient({ "User-Agent": "VSCode/1.90 electron" })).toBe("vscode")
  })

  test("returns null when no user-agent header is present", () => {
    expect(normalizeClient(undefined)).toBeNull()
    expect(normalizeClient({ "x-app": "cli" })).toBeNull()
  })

  test("whitespace-only user-agent → 'unknown'", () => {
    expect(normalizeClient({ "user-agent": "   " })).toBe("unknown")
  })
})

describe("extractToolNames", () => {
  test("extracts distinct Anthropic content-block tool_use names (excludes text/thinking)", () => {
    const entry = makeEntry({
      outboundResponse: {
        success: true,
        model: "claude-opus-4.8",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: {
          role: "assistant",
          content: [
            { type: "text", text: "hi" },
            { type: "tool_use", id: "t1", name: "Read", input: {} },
            { type: "tool_use", id: "t2", name: "Bash", input: {} },
            { type: "tool_use", id: "t3", name: "Read", input: {} }, // duplicate name → deduped
          ],
        },
      },
    })
    expect(extractToolNames(entry).sort()).toEqual(["Bash", "Read"])
  })

  test("extracts OpenAI/Responses tool_calls function names", () => {
    const entry = makeEntry({
      endpoint: "openai-chat-completions",
      outboundResponse: {
        success: true,
        model: "gpt-5.2",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } },
            { id: "c2", type: "function", function: { name: "search", arguments: "{}" } },
          ],
        },
      },
    })
    expect(extractToolNames(entry).sort()).toEqual(["get_weather", "search"])
  })

  test("returns [] when the response invoked no tools or has no content", () => {
    expect(extractToolNames(makeEntry())).toEqual([])
    expect(
      extractToolNames(
        makeEntry({
          outboundResponse: { success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: { role: "assistant", content: "plain text" } },
        }),
      ),
    ).toEqual([])
  })
})

describe("extractTelemetryKeys", () => {
  test("resolves every registered dimension; agentKind reflects agentId presence", () => {
    const main = extractTelemetryKeys(makeEntry({ httpHeaders: { inboundRequest: { "user-agent": "claude-cli/1.0" } } }), ctxStub)
    expect(main.model).toBe("claude-opus-4.8")
    expect(main.endpoint).toBe("anthropic-messages")
    expect(main.client).toBe("claude-cli")
    expect(main.agentKind).toBe("main")
    expect(main.tool).toEqual([])

    const sub = extractTelemetryKeys(makeEntry({ agentId: "agent-xyz" }), ctxStub)
    expect(sub.agentKind).toBe("subagent")
    expect(sub.client).toBeNull() // no user-agent captured
  })
})

describe("CAPPED_DIMENSION_NAMES", () => {
  test("marks the user/agent-driven dimensions as capped, not model/endpoint/agentKind", () => {
    expect(CAPPED_DIMENSION_NAMES.has("client")).toBe(true)
    expect(CAPPED_DIMENSION_NAMES.has("tool")).toBe(true)
    expect(CAPPED_DIMENSION_NAMES.has("model")).toBe(false)
    expect(CAPPED_DIMENSION_NAMES.has("endpoint")).toBe(false)
    expect(CAPPED_DIMENSION_NAMES.has("agentKind")).toBe(false)
  })
})

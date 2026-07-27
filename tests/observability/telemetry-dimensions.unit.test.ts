import {
  //
  CAPPED_DIMENSION_NAMES,
  TELEMETRY_DIMENSION_NAMES,
  TELEMETRY_DIMENSION_SPECS,
} from "@hsupu/ghc-proxy-telemetry"
import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntryData } from "~/lib/context/types"

import {
  //
  extractTelemetryKeys,
  extractThinkingBlockCounts,
  extractToolNames,
  normalizeClient,
  TELEMETRY_DIMENSIONS,
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
    durationMs: 1,
    model: { resolved: "claude-opus-4.8" },
    ...overrides,
  }
}

// A ctx snapshot isn't read by the current extractors; cast a stub.
const ctxStub = {} as never

describe("max_tokens_truncation dimension", () => {
  test("extracts the persisted truncation class and skips entries with no max_tokens terminal", () => {
    expect(
      extractTelemetryKeys(
        makeEntry({
          pipelineInfo: {
            maxTokensContinuation: {
              truncationClass: "thinking",
              roundsAttempted: 1,
              roundsSucceeded: 0,
              continuedTokens: 0,
              perRoundStopReason: ["max_tokens"],
              clientVisibleStopReason: "max_tokens",
              suppressedMaxTokens: false,
              visibilityMode: "passthrough",
            },
          },
        }),
        ctxStub,
      ).max_tokens_truncation,
    ).toBe("thinking")
    expect(extractTelemetryKeys(makeEntry(), ctxStub).max_tokens_truncation).toBeNull()
  })
})

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
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "claude-opus-4.8",
            usage: { input_tokens: 1, output_tokens: 1 },
            body: {
              role: "assistant",
              content: [
                { type: "text", text: "hi" },
                { type: "tool_use", id: "t1", name: "Read", input: {} },
                { type: "tool_use", id: "t2", name: "Bash", input: {} },
                { type: "tool_use", id: "t3", name: "Read", input: {} }, // duplicate name → deduped
              ],
            },
          },
        },
      ],
    })
    expect(extractToolNames(entry).sort()).toEqual(["Bash", "Read"])
  })

  test("extracts OpenAI/Responses tool_calls function names", () => {
    const entry = makeEntry({
      endpoint: "openai-chat-completions",
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "gpt-5.2",
            usage: { input_tokens: 1, output_tokens: 1 },
            body: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } },
                { id: "c2", type: "function", function: { name: "search", arguments: "{}" } },
              ],
            },
          },
        },
      ],
    })
    expect(extractToolNames(entry).sort()).toEqual(["get_weather", "search"])
  })

  test("returns [] when the response invoked no tools or has no content", () => {
    expect(extractToolNames(makeEntry())).toEqual([])
    expect(
      extractToolNames(
        makeEntry({
          attempts: [
            {
              index: 0,
              durationMs: 0,
              upstreamResponse: { success: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, body: { role: "assistant", content: "plain text" } },
            },
          ],
        }),
      ),
    ).toEqual([])
  })
})

describe("extractThinkingBlockCounts", () => {
  const withBlocks = (blocks: Array<unknown>): HistoryEntryData =>
    makeEntry({
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "claude-opus-4.8",
            usage: { input_tokens: 1, output_tokens: 1 },
            body: { role: "assistant", content: blocks },
          },
        },
      ],
    })

  test("non-empty thinking → nonEmpty", () => {
    expect(extractThinkingBlockCounts(withBlocks([{ type: "thinking", thinking: "let me reason", signature: "sig" }]))).toEqual({
      nonEmpty: 1,
      emptySigned: 0,
      emptyUnsigned: 0,
    })
  })

  test("empty thinking WITH signature → emptySigned (normal encrypted / compat block)", () => {
    expect(extractThinkingBlockCounts(withBlocks([{ type: "thinking", thinking: "", signature: "EoAQ-sig" }]))).toEqual({
      nonEmpty: 0,
      emptySigned: 1,
      emptyUnsigned: 0,
    })
  })

  test("empty thinking, NO signature → emptyUnsigned (corrupt double-empty block)", () => {
    expect(extractThinkingBlockCounts(withBlocks([{ type: "thinking", thinking: "" }]))).toEqual({
      nonEmpty: 0,
      emptySigned: 0,
      emptyUnsigned: 1,
    })
  })

  test("whitespace-only thinking counts as empty", () => {
    expect(extractThinkingBlockCounts(withBlocks([{ type: "thinking", thinking: "   ", signature: "s" }]))).toEqual({
      nonEmpty: 0,
      emptySigned: 1,
      emptyUnsigned: 0,
    })
  })

  test("signature three-state (empty string / null / missing key) all → emptyUnsigned", () => {
    expect(
      extractThinkingBlockCounts(
        withBlocks([
          { type: "thinking", thinking: "", signature: "" },
          { type: "thinking", thinking: "", signature: null },
          { type: "thinking", thinking: "" },
        ]),
      ),
    ).toEqual({ nonEmpty: 0, emptySigned: 0, emptyUnsigned: 3 })
  })

  test("non-string thinking field → treated as empty (falls to signature bucket)", () => {
    expect(extractThinkingBlockCounts(withBlocks([{ type: "thinking", signature: "s" }]))).toEqual({
      nonEmpty: 0,
      emptySigned: 1,
      emptyUnsigned: 0,
    })
  })

  test("mixed blocks tally per bucket; redacted_thinking / text / tool_use excluded (redacted not mis-bucketed as emptyUnsigned)", () => {
    expect(
      extractThinkingBlockCounts(
        withBlocks([
          { type: "thinking", thinking: "reasoning", signature: "s1" }, // nonEmpty
          { type: "thinking", thinking: "", signature: "s2" }, // emptySigned
          { type: "thinking", thinking: "" }, // emptyUnsigned
          { type: "redacted_thinking", data: "opaque" }, // NOT counted (has data, no thinking)
          { type: "text", text: "answer" },
          { type: "tool_use", id: "t", name: "Read", input: {} },
          { type: "server_tool_use", id: "s", name: "web_search", input: {} },
        ]),
      ),
    ).toEqual({ nonEmpty: 1, emptySigned: 1, emptyUnsigned: 1 })
  })

  test("CC real shape (content.content is a string) → all zero", () => {
    const entry = makeEntry({
      endpoint: "openai-chat-completions",
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "gpt-5.2",
            usage: { input_tokens: 1, output_tokens: 1 },
            body: { role: "assistant", content: "plain assistant text" },
          },
        },
      ],
    })
    expect(extractThinkingBlockCounts(entry)).toEqual({ nonEmpty: 0, emptySigned: 0, emptyUnsigned: 0 })
  })

  test("no outboundResponse / null content / empty array → all zero", () => {
    const zero = { nonEmpty: 0, emptySigned: 0, emptyUnsigned: 0 }
    expect(extractThinkingBlockCounts(makeEntry())).toEqual(zero)
    expect(extractThinkingBlockCounts(withBlocks([]))).toEqual(zero)
    expect(
      extractThinkingBlockCounts(
        makeEntry({
          attempts: [{ index: 0, durationMs: 0, upstreamResponse: { success: false, model: "m", usage: { input_tokens: 0, output_tokens: 0 }, body: null } }],
        }),
      ),
    ).toEqual(zero)
  })
})

describe("extractTelemetryKeys", () => {
  test("resolves every registered dimension; agentKind reflects agentId presence", () => {
    const main = extractTelemetryKeys(makeEntry({ clientRequest: { headers: { "user-agent": "claude-cli/1.0" } } }), ctxStub)
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
  test("marks the client-controlled dimensions (model/client/tool) as capped, not the bounded enums", () => {
    // model is capped too: its key is the raw client-supplied model string (recorded even on
    // upstream-400 failures), so it's client-controllable and must be bounded — see CRITICAL-1.
    expect(CAPPED_DIMENSION_NAMES.has("model")).toBe(true)
    expect(CAPPED_DIMENSION_NAMES.has("client")).toBe(true)
    expect(CAPPED_DIMENSION_NAMES.has("tool")).toBe(true)
    expect(CAPPED_DIMENSION_NAMES.has("endpoint")).toBe(false)
    expect(CAPPED_DIMENSION_NAMES.has("agentKind")).toBe(false)
  })
})

describe("T3 split: the name registry and the extractors live on opposite sides of the domain boundary", () => {
  test("every domain-owned spec is joined with a core-owned extractor (no dimension loses its resolver)", () => {
    // The join is what the split must preserve: names come from the telemetry domain, extractors
    // from core, and TELEMETRY_DIMENSIONS is exactly their pairing — same names, same order,
    // every one carrying a callable extractor.
    expect(TELEMETRY_DIMENSIONS.map((dim) => dim.name)).toEqual([...TELEMETRY_DIMENSION_NAMES])
    expect(TELEMETRY_DIMENSIONS.map((dim) => dim.cardinality)).toEqual(TELEMETRY_DIMENSION_SPECS.map((spec) => spec.cardinality))
    for (const dim of TELEMETRY_DIMENSIONS) expect(typeof dim.extract).toBe("function")
  })

  test("the capped set is derived from the domain-owned specs, not restated in core", () => {
    expect([...CAPPED_DIMENSION_NAMES].sort()).toEqual(
      TELEMETRY_DIMENSION_SPECS.filter((spec) => spec.cardinality === "capped")
        .map((spec) => spec.name)
        .sort(),
    )
    // Non-vacuous: the split would be pointless if nothing were capped.
    expect(CAPPED_DIMENSION_NAMES.size).toBeGreaterThan(0)
  })

  test("extractTelemetryKeys resolves a key slot for EVERY registered name (the split kept the registry whole)", () => {
    const keys = extractTelemetryKeys(makeEntry(), ctxStub)
    expect(Object.keys(keys).sort()).toEqual([...TELEMETRY_DIMENSION_NAMES].sort())
  })
})

/**
 * F28/F32 — CC 2.1.207 tool inventory completion.
 *
 * F28 landed as a root-cause fix (ungating the Path 2 history-stub safety net
 * from tool_search — see `message-tools.ts`), NOT a `CLAUDE_CODE_OFFICIAL_TOOLS`
 * list addition — that list addition was reverted as redundant once the safety
 * net covers any orphaned history tool_use regardless of official-tool status.
 * F32's `API_DEFINED_TOOL_TYPE_PREFIXES` additions are a genuine list addition
 * (kept).
 *
 * `API_DEFINED_TOOL_TYPE_PREFIXES` is an internal constant (not exported) —
 * every assertion below goes through the same public surface production code
 * uses (`preprocessTools`, `isApiDefinedToolType`, `buildAnthropicToolNameMapper`),
 * so a passing test actually exercises the underlying logic rather than merely
 * re-stating it.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  MessagesPayload,
  Tool,
} from "~/types/api/anthropic"

import {
  //
  isApiDefinedToolType,
  preprocessTools,
} from "~/lib/anthropic/message-tools"
import { buildAnthropicToolNameMapper } from "~/lib/anthropic/sanitize/tool-name-sanitize"
import {
  //
  setStateForTests,
  state,
} from "~/lib/state"

function makePayload(overrides: Partial<MessagesPayload> = {}): MessagesPayload {
  return {
    model: "claude-sonnet-4.6",
    max_tokens: 1024,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    ...overrides,
  }
}

function toolNames(tools: Array<Tool> | undefined): Array<string> {
  return (tools ?? []).map((t) => t.name)
}

describe("F28 root cause — history-stub safety net (Path 2) is not gated on tool_search", () => {
  let originalToolSearchEnabled: typeof state.toolSearchEnabled
  let originalInject: typeof state.injectClaudeCodeOfficialTools

  beforeEach(() => {
    originalToolSearchEnabled = state.toolSearchEnabled
    originalInject = state.injectClaudeCodeOfficialTools
    // Path 1 (injectClaudeCodeOfficialTools) is a separate, unconditional stub source —
    // disable it here so only Path 2 (the history-reference safety net under test) fires.
    setStateForTests({ toolSearchEnabled: false, injectClaudeCodeOfficialTools: false })
  })

  afterEach(() => {
    setStateForTests({ toolSearchEnabled: originalToolSearchEnabled, injectClaudeCodeOfficialTools: originalInject })
  })

  test("injects a stub for an orphaned non-official history tool_use even with tool_search OFF", () => {
    // tool_search OFF (state.toolSearchEnabled=false) — before the fix, `historyToolNames`
    // was computed as `undefined` in this branch, so Path 2's name-agnostic safety net
    // never ran and GHC would reject the request over the dangling tool_use reference.
    const result = preprocessTools(
      makePayload({
        tools: [{ name: "custom_tool", input_schema: { type: "object" } }],
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "some_mcp_tool", input: {} }],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
        ],
      }),
    )

    const names = toolNames(result.tools)
    expect(names).toContain("some_mcp_tool")

    const stub = (result.tools ?? []).find((t) => t.name === "some_mcp_tool")
    expect(stub).toMatchObject({
      name: "some_mcp_tool",
      input_schema: { type: "object", properties: {}, required: [] },
    })
  })

  test("negative control: no orphaned history reference means no extra stub is injected", () => {
    // Same tool_search-OFF state, but history contains no tool_use at all — proves the
    // safety net is reference-driven (only fires when there's something to backfill),
    // not an unconditional injection now that it's no longer gated on tool_search.
    const result = preprocessTools(
      makePayload({
        tools: [{ name: "custom_tool", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    )

    const names = toolNames(result.tools)
    expect(names).toEqual(["custom_tool"])
  })
})

describe("F32 — isApiDefinedToolType (message-tools.ts)", () => {
  test("recognizes the newly added CC 2.1.207 server-tool type prefixes", () => {
    expect(isApiDefinedToolType("advisor_20260301")).toBe(true)
    expect(isApiDefinedToolType("agent_toolset_20260401")).toBe(true)
    expect(isApiDefinedToolType("memory_20250818")).toBe(true)
    expect(isApiDefinedToolType("tool_search_tool_regex_20251119")).toBe(true)
  })

  test("negative sample: a custom (non-API-defined) type string is not recognized", () => {
    expect(isApiDefinedToolType("my_custom_tool")).toBe(false)
    expect(isApiDefinedToolType(undefined)).toBe(false)
  })
})

describe("F32 — buildAnthropicToolNameMapper excludes newly recognized API-defined types", () => {
  let originalSanitize: typeof state.sanitizeToolNames

  beforeEach(() => {
    originalSanitize = state.sanitizeToolNames
    setStateForTests({ sanitizeToolNames: true })
  })

  afterEach(() => {
    setStateForTests({ sanitizeToolNames: originalSanitize })
  })

  test("an advisor_-typed tool is excluded from the custom-name set (not sanitized/renamed)", () => {
    const tools: Array<Tool> = [
      // Illegal chars force a real rename so the mapper reports hasChanges — otherwise
      // buildAnthropicToolNameMapper short-circuits to null and the test would be vacuous.
      { name: "my custom tool", input_schema: { type: "object" } },
      { name: "advisor_thing", type: "advisor_20260301" },
    ]

    const mapper = buildAnthropicToolNameMapper(tools, "claude-sonnet-4.6")

    expect(mapper).not.toBeNull()
    // Positive contrast: the custom tool IS in the mapper's original set (proves the
    // mapper actually ran over these tools) while the advisor_-typed one is excluded.
    expect(mapper?.hasOriginal("my custom tool")).toBe(true)
    expect(mapper?.hasOriginal("advisor_thing")).toBe(false)
  })
})

/**
 * Characterization (accepted tradeoff, 2026-07-14): non-defer coverage of the
 * `NON_DEFERRED_TOOL_NAMES` spread source is the 16-item `CLAUDE_CODE_OFFICIAL_TOOLS`
 * list. Hot-path tools stay loaded; rarely-used CC tools NOT in that list (WebSearch,
 * BashOutput, …) ARE deferred under tool_search — the tool_search feature working as
 * designed (context savings; first use self-heals via deferred-tool-retry). Pins the
 * current boundary so a future change to non-defer coverage is visible in review.
 * Rationale + "if we ever change it" → docs/todo/deferred-backlog.md. Implicitly depends on claude-sonnet-4.6 triggering tool_search; if the model
 * capability table changes, the anyDeferred guard goes red first — update the anchor model then.
 */
describe("accepted tradeoff — non-official CC tools are deferred under tool_search", () => {
  let originalToolSearchEnabled: typeof state.toolSearchEnabled

  beforeEach(() => {
    originalToolSearchEnabled = state.toolSearchEnabled
    setStateForTests({ toolSearchEnabled: true })
  })
  afterEach(() => {
    setStateForTests({ toolSearchEnabled: originalToolSearchEnabled })
  })

  test("hot-path official tool (Read) stays loaded; rarely-used WebSearch is deferred", () => {
    const payload = makePayload({
      model: "claude-sonnet-4.6",
      tools: [
        { name: "Read", input_schema: { type: "object", properties: {} } },
        { name: "WebSearch", input_schema: { type: "object", properties: {} } },
      ] as Array<Tool>,
    })
    const out = preprocessTools(payload)
    const byName = new Map((out.tools ?? []).map((t) => [t.name, t as Tool & { defer_loading?: boolean }]))
    // Only meaningful if tool_search actually engaged for this model (positive control):
    // at least one tool must be deferred, else the assertion below is vacuous.
    const anyDeferred = (out.tools ?? []).some((t) => (t as { defer_loading?: boolean }).defer_loading === true)
    expect(anyDeferred).toBe(true)
    expect(byName.get("Read")?.defer_loading).not.toBe(true) // hot-path: protected
    expect(byName.get("WebSearch")?.defer_loading).toBe(true) // rarely-used: deferred (accepted)
  })
})

/**
 * F32 completeness (whole-branch review, 2026-07-14): `isApiDefinedToolType` has a
 * THIRD consumer beyond sanitize + shouldDefer — the universal-translation-matrix CC
 * leg (`anthropic-to-cc-request.ts` translateTools). Adding the 4 prefixes means those
 * typed server tools are now DROPPED on that leg (matching web_search_/code_execution_)
 * rather than translated into a malformed `{function:{parameters:undefined}}`. Pinned
 * here via the shared predicate so the third consumer's behavior stays characterized.
 */
describe("F32 — typed server tools recognized by isApiDefinedToolType (translateTools consumer)", () => {
  test("new prefixes are API-defined → dropped on the CC translation leg; custom tools kept", () => {
    // translateTools drops any tool whose type isApiDefinedToolType(type)===true.
    for (const type of ["advisor_20260301", "agent_toolset_20260401", "memory_20250818", "tool_search_tool_regex_20251119"]) {
      expect(isApiDefinedToolType(type)).toBe(true) // → dropped on CC leg (improvement over malformed)
    }
    // A genuine custom tool is NOT API-defined → translateTools keeps translating it.
    expect(isApiDefinedToolType("get_weather")).toBe(false)
  })
})

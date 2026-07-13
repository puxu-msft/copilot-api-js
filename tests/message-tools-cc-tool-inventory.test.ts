/**
 * F28/F32 — CC 2.1.207 tool inventory completion.
 *
 * `CLAUDE_CODE_OFFICIAL_TOOLS` and `API_DEFINED_TOOL_TYPE_PREFIXES` are internal
 * constants (not exported) — every assertion below goes through the same public
 * surface production code uses (`preprocessTools`, `isApiDefinedToolType`,
 * `buildAnthropicToolNameMapper`), so a passing test actually exercises the
 * updated lists rather than merely re-stating them.
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

describe("F28 — CLAUDE_CODE_OFFICIAL_TOOLS stub injection (message-tools.ts)", () => {
  let originalInject: typeof state.injectClaudeCodeOfficialTools

  beforeEach(() => {
    originalInject = state.injectClaudeCodeOfficialTools
    setStateForTests({ injectClaudeCodeOfficialTools: true })
  })

  afterEach(() => {
    setStateForTests({ injectClaudeCodeOfficialTools: originalInject })
  })

  test("injects stubs for the newly added CC 2.1.207 tools when missing", () => {
    const result = preprocessTools(
      makePayload({
        tools: [{ name: "custom_tool", input_schema: { type: "object" } }],
        // No tool_use in history — this isolates the CLAUDE_CODE_OFFICIAL_TOOLS-driven
        // stub injection from the separate history-reference stub mechanism.
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    )

    const names = toolNames(result.tools)

    // New F28 additions must be present as stubs.
    for (const name of ["WebSearch", "BashOutput", "NotebookRead", "ListMcpResources", "ReadMcpResource"]) {
      expect(names).toContain(name)
    }

    // Original 16 must still be present (no accidental deletion).
    for (const name of [
      "Task",
      "TaskOutput",
      "Bash",
      "Glob",
      "Grep",
      "Read",
      "Edit",
      "Write",
      "NotebookEdit",
      "WebFetch",
      "TodoWrite",
      "KillShell",
      "AskUserQuestion",
      "Skill",
      "EnterPlanMode",
      "ExitPlanMode",
    ]) {
      expect(names).toContain(name)
    }

    // Sanity: the stub actually has the expected shape.
    const webSearchStub = (result.tools ?? []).find((t) => t.name === "WebSearch")
    expect(webSearchStub).toMatchObject({
      name: "WebSearch",
      input_schema: { type: "object", properties: {}, required: [] },
    })
  })

  test("negative control: does NOT inject tools deliberately excluded from the list (MultiEdit / Agent)", () => {
    // Proves injection is list-driven (selective), not "inject anything CC-shaped" —
    // and doubles as a regression guard on the plan's explicit non-addition decision.
    const result = preprocessTools(
      makePayload({
        tools: [{ name: "custom_tool", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    )

    const names = toolNames(result.tools)
    expect(names).not.toContain("MultiEdit")
    expect(names).not.toContain("Agent")
  })
})

describe("F28 — NON_DEFERRED_TOOL_NAMES spread (tool_search defer_loading)", () => {
  test("WebSearch (newly added) stays non-deferred alongside a custom tool that IS deferred", () => {
    // Model must support tool_search for defer_loading to apply at all — reuses the
    // same model as the existing "orders tools" test in anthropic-message-tools.unit.test.ts.
    const result = preprocessTools(
      makePayload({
        tools: [
          { name: "WebSearch", input_schema: { type: "object" } },
          { name: "custom_deferred_tool", input_schema: { type: "object" } },
        ],
      }),
    )

    const tools = result.tools ?? []
    const webSearch = tools.find((t) => t.name === "WebSearch")
    const custom = tools.find((t) => t.name === "custom_deferred_tool")

    expect(webSearch).toBeDefined()
    expect(custom).toBeDefined()

    // Positive contrast: the custom tool (NOT in CLAUDE_CODE_OFFICIAL_TOOLS) IS deferred,
    // proving tool_search is actually active in this test and would defer WebSearch too
    // if the spread hadn't picked it up.
    expect(custom?.defer_loading).toBe(true)
    expect(webSearch?.defer_loading).toBeUndefined()
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

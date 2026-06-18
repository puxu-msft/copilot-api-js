/**
 * Unit tests for upstream tool-schema diagnostics.
 *
 * Coverage: suspect-keyword detection (path form), suspicious tool-name
 * detection, Anthropic/OpenAI/Responses tool-shape normalization, empty /
 * non-array inputs, and per-category truncation at MAX_DIAGNOSTIC_ITEMS.
 */

import {
  //
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import {
  //
  logUpstreamStreamDisconnect,
  summarizeToolsForDiagnostics,
} from "~/lib/upstream-diagnostics"

describe("summarizeToolsForDiagnostics", () => {
  describe("non-tool inputs", () => {
    test("returns undefined for non-array input", () => {
      // Arrange / Act / Assert
      expect(summarizeToolsForDiagnostics(undefined)).toBeUndefined()
      expect(summarizeToolsForDiagnostics(null)).toBeUndefined()
      expect(summarizeToolsForDiagnostics({})).toBeUndefined()
      expect(summarizeToolsForDiagnostics("tools")).toBeUndefined()
    })

    test("returns undefined for empty array", () => {
      expect(summarizeToolsForDiagnostics([])).toBeUndefined()
    })

    test("returns undefined when nothing is suspicious", () => {
      // Arrange
      const tools = [{ name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }]

      // Act
      const result = summarizeToolsForDiagnostics(tools)

      // Assert
      expect(result).toBeUndefined()
    })
  })

  describe("suspicious schema keywords", () => {
    test("detects oneOf in Anthropic tool with path form", () => {
      // Arrange
      const tools = [{ name: "pick", input_schema: { type: "object", properties: { x: { oneOf: [{ type: "string" }] } } } }]

      // Act
      const result = summarizeToolsForDiagnostics(tools)

      // Assert
      expect(result).toBeDefined()
      expect(result?.count).toBe(1)
      expect(result?.invalidNames).toBeUndefined()
      expect(result?.suspiciousSchemas).toEqual([{ name: "pick", keys: ["$.properties.x.oneOf"] }])
    })

    test("detects top-level $defs and allOf", () => {
      // Arrange
      const tools = [{ name: "complex", input_schema: { $defs: { foo: { type: "string" } }, allOf: [{ type: "object" }] } }]

      // Act
      const result = summarizeToolsForDiagnostics(tools)

      // Assert
      expect(result?.suspiciousSchemas?.[0]?.name).toBe("complex")
      expect(result?.suspiciousSchemas?.[0]?.keys).toContain("$.$defs")
      expect(result?.suspiciousSchemas?.[0]?.keys).toContain("$.allOf")
    })

    test("detects nested keyword inside array items with index path", () => {
      // Arrange
      const tools = [{ name: "arr", input_schema: { type: "array", items: { anyChild: [{ not: { type: "string" } }] } } }]

      // Act
      const result = summarizeToolsForDiagnostics(tools)

      // Assert
      expect(result?.suspiciousSchemas?.[0]?.keys).toContain("$.items.anyChild[0].not")
    })

    test("detects all suspect keywords", () => {
      // Arrange — one tool whose schema contains every suspect keyword at top level
      const schema: Record<string, unknown> = {}
      const keywords = ["$defs", "oneOf", "allOf", "patternProperties", "if", "then", "else", "not", "definitions", "dependentRequired", "dependentSchemas"]
      for (const kw of keywords) schema[kw] = {}
      const tools = [{ name: "kitchen_sink", input_schema: schema }]

      // Act
      const result = summarizeToolsForDiagnostics(tools)

      // Assert — capped at MAX_DIAGNOSTIC_ITEMS (8) per tool
      expect(result?.suspiciousSchemas?.[0]?.keys.length).toBe(8)
    })
  })

  describe("suspicious tool names", () => {
    test("flags name with dot as suspicious", () => {
      // Arrange
      const tools = [{ name: "namespace.tool", input_schema: { type: "object" } }]

      // Act
      const result = summarizeToolsForDiagnostics(tools)

      // Assert
      expect(result?.invalidNames).toEqual(["namespace.tool"])
    })

    test("flags overlong name (>64 chars)", () => {
      // Arrange
      const longName = "a".repeat(65)
      const tools = [{ name: longName, input_schema: { type: "object" } }]

      // Act
      const result = summarizeToolsForDiagnostics(tools)

      // Assert
      expect(result?.invalidNames).toEqual([longName])
    })

    test("flags empty name", () => {
      // Arrange
      const tools = [{ name: "", input_schema: { type: "object" } }]

      // Act
      const result = summarizeToolsForDiagnostics(tools)

      // Assert
      expect(result?.invalidNames).toEqual([""])
    })

    test("accepts valid name with allowed chars", () => {
      // Arrange
      const tools = [{ name: "valid_Name-123", input_schema: { type: "object" } }]

      // Act
      const result = summarizeToolsForDiagnostics(tools)

      // Assert
      expect(result).toBeUndefined()
    })
  })

  describe("shape normalization", () => {
    test("normalizes OpenAI function shape", () => {
      // Arrange
      const tools = [{ type: "function", function: { name: "bad.name", parameters: { type: "object", properties: { y: { allOf: [] } } } } }]

      // Act
      const result = summarizeToolsForDiagnostics(tools)

      // Assert
      expect(result?.invalidNames).toEqual(["bad.name"])
      expect(result?.suspiciousSchemas?.[0]?.keys).toContain("$.properties.y.allOf")
    })

    test("normalizes Responses flat shape (name + parameters)", () => {
      // Arrange
      const tools = [{ type: "function", name: "search.web", parameters: { type: "object", properties: { q: { oneOf: [] } } } }]

      // Act
      const result = summarizeToolsForDiagnostics(tools)

      // Assert
      expect(result?.invalidNames).toEqual(["search.web"])
      expect(result?.suspiciousSchemas?.[0]?.keys).toContain("$.properties.q.oneOf")
    })

    test("skips uninterpretable tool shapes", () => {
      // Arrange — no name, no function
      const tools = [{ description: "anonymous" }, { name: "ok_tool", input_schema: { type: "object" } }]

      // Act
      const result = summarizeToolsForDiagnostics(tools)

      // Assert — count reflects array length, but nothing suspicious found
      expect(result).toBeUndefined()
    })
  })

  describe("truncation", () => {
    test("caps invalidNames at MAX_DIAGNOSTIC_ITEMS (8)", () => {
      // Arrange — 12 tools with dotted (suspicious) names
      const tools = Array.from({ length: 12 }, (_, i) => ({ name: `bad.tool.${i}`, input_schema: { type: "object" } }))

      // Act
      const result = summarizeToolsForDiagnostics(tools)

      // Assert
      expect(result?.count).toBe(12)
      expect(result?.invalidNames?.length).toBe(8)
    })

    test("caps suspiciousSchemas at MAX_DIAGNOSTIC_ITEMS (8)", () => {
      // Arrange — 12 tools each with a suspect keyword
      const tools = Array.from({ length: 12 }, (_, i) => ({ name: `tool_${i}`, input_schema: { oneOf: [] } }))

      // Act
      const result = summarizeToolsForDiagnostics(tools)

      // Assert
      expect(result?.suspiciousSchemas?.length).toBe(8)
    })
  })

  describe("recursion guards", () => {
    test("terminates on a circular schema without throwing", () => {
      // Arrange — schema with a self-reference (would loop without WeakSet guard)
      const circular: Record<string, unknown> = { type: "object", properties: {} }
      circular.self = circular

      // Act + Assert — must not stack-overflow / hang
      const result = summarizeToolsForDiagnostics([{ name: "looping", input_schema: circular }])

      // No suspect keyword present, so nothing flagged, and it returns cleanly
      expect(result).toBeUndefined()
    })

    test("still flags a suspect keyword reachable through a cycle", () => {
      // Arrange — suspect keyword on the node, plus a back-edge
      const node: Record<string, unknown> = { oneOf: [] }
      node.back = node

      // Act
      const result = summarizeToolsForDiagnostics([{ name: "cyclic", input_schema: node }])

      // Assert — keyword found exactly once, no infinite recursion
      expect(result?.suspiciousSchemas?.[0]?.keys).toContain("$.oneOf")
    })

    test("does not throw on a very deeply nested schema (depth guard)", () => {
      // Arrange — nest well beyond MAX_SCHEMA_DEPTH (100)
      let deep: Record<string, unknown> = { type: "string" }
      for (let i = 0; i < 300; i++) deep = { properties: { child: deep } }

      // Act + Assert — depth guard prevents runaway recursion
      expect(() => summarizeToolsForDiagnostics([{ name: "deep", input_schema: deep }])).not.toThrow()
    })
  })
})

describe("logUpstreamStreamDisconnect", () => {
  // consola's LogFn requires both a call signature and a `.raw` property.
  const noop = Object.assign((..._: Array<any>) => {}, { raw: (..._: Array<any>) => {} })

  test("surfaces the silence gap (elapsed − last-frame offset) — the stall signature", () => {
    // Arrange — opus went silent after content_block_start@201ms, cut at 31523ms
    const spy = spyOn(consola, "error").mockImplementation(noop)
    try {
      logUpstreamStreamDisconnect({
        model: "claude-opus-4.8",
        kindLabel: "transport-close",
        detail: "terminated (cause: other side closed)",
        elapsedMs: 31_523,
        frames: 2,
        bytes: 3072,
        lastFrameType: "content_block_start",
        lastFrameOffsetMs: 201,
        stuckBlockType: "thinking",
        inputTokens: 202_331,
        outputTokens: 4,
      })

      // Assert — one line carrying the diagnostic, with silence = 31523 − 201
      expect(spy).toHaveBeenCalledTimes(1)
      const line = spy.mock.calls[0]?.[0] as string
      expect(line).toContain("model=claude-opus-4.8")
      expect(line).toContain("kind=transport-close")
      expect(line).toContain("terminated (cause: other side closed)")
      expect(line).toContain("last-frame=content_block_start@201ms")
      expect(line).toContain("silence=31322ms")
      expect(line).toContain("stuck-block=thinking")
      expect(line).toContain("tokens(in/out)=202331/4")
      // keepalive setting surfaced + middlebox-reclaim heuristic fires for this
      // signature (transport-close, long silence, few frames, thinking stall).
      expect(line).toContain("keepalive=")
      expect(line).toContain("likely=middlebox-idle-reclaim-during-thinking-stall")
      expect(line).toContain("timeouts.upstream_keepalive")
    } finally {
      spy.mockRestore()
    }
  })

  test("renders 'none' placeholders when no frame arrived before the cut", () => {
    const spy = spyOn(consola, "error").mockImplementation(noop)
    try {
      logUpstreamStreamDisconnect({
        model: "claude-opus-4.8",
        kindLabel: "idle-timeout",
        detail: "Stream idle timeout",
        elapsedMs: 600_000,
        frames: 0,
        bytes: 0,
        lastFrameOffsetMs: 0,
        stuckBlockType: "",
        inputTokens: 0,
        outputTokens: 0,
      })

      const line = spy.mock.calls[0]?.[0] as string
      expect(line).toContain("last-frame=none@0ms")
      expect(line).toContain("silence=600000ms")
      expect(line).toContain("stuck-block=none")
      // idle-timeout is our own watchdog, not a middlebox reclaim — no likely= hint
      expect(line).not.toContain("likely=")
    } finally {
      spy.mockRestore()
    }
  })

  test("does not flag middlebox reclaim when the silence is short", () => {
    const spy = spyOn(consola, "error").mockImplementation(noop)
    try {
      logUpstreamStreamDisconnect({
        model: "claude-opus-4.8",
        kindLabel: "transport-close",
        detail: "terminated (cause: other side closed)",
        elapsedMs: 5_000,
        frames: 2,
        bytes: 100,
        lastFrameType: "content_block_start",
        lastFrameOffsetMs: 100,
        stuckBlockType: "thinking",
        inputTokens: 10,
        outputTokens: 0,
      })

      const line = spy.mock.calls[0]?.[0] as string
      // silence = 4900ms < 30s threshold → a genuine error, not an idle reclaim
      expect(line).not.toContain("likely=")
      // keepalive setting is still surfaced regardless of the heuristic
      expect(line).toContain("keepalive=")
    } finally {
      spy.mockRestore()
    }
  })
})

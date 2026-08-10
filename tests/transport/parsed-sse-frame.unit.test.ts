import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ParsedSseFrame } from "~/lib/transport/parsed-sse-frame"

import {
  //
  readSyntheticKind,
  tagFrameSynthetic,
} from "~/lib/pipeline/frame-origin"
import {
  //
  mapSemanticSseFrame,
  projectParsedSseFrame,
  semanticSseMessage,
} from "~/lib/transport/parsed-sse-frame"

function parsed(id: string, idField: ParsedSseFrame["idField"]): ParsedSseFrame {
  return { kind: "parsed-sse", message: { event: "message", data: "a", id, retry: 0 }, idField }
}

describe("parsed SSE semantic and wire boundaries", () => {
  test("projects absent, explicit empty, and inherited IDs by event-local presence", () => {
    expect(projectParsedSseFrame(parsed("", { kind: "absent" }))).toEqual({ event: "message", data: "a", retry: 0 })
    expect(projectParsedSseFrame(parsed("", { kind: "present", value: "" }))).toEqual({ event: "message", data: "a", id: "", retry: 0 })
    expect(projectParsedSseFrame(parsed("alpha", { kind: "absent" }))).toEqual({ event: "message", data: "a", retry: 0 })
    expect(projectParsedSseFrame(parsed("alpha", { kind: "present", value: "alpha" }))).toEqual({ event: "message", data: "a", id: "alpha", retry: 0 })
  })

  test("keeps the parsed wrapper only for an identity-preserving rewrite", () => {
    const input = parsed("alpha", { kind: "absent" })
    expect(semanticSseMessage(input)).toBe(input.message)
    expect(mapSemanticSseFrame(input, (message) => message, "preserve")).toBe(input)
  })

  test("keeps a fresh synthetic rewrite plain and preserves only its declared origin", () => {
    const input = parsed("alpha", { kind: "present", value: "alpha" })
    const synthetic = tagFrameSynthetic({ event: "error", data: "recovered" }, "refusal-recovery")
    const output = mapSemanticSseFrame(input, () => synthetic, "fresh")
    expect(output).toBe(synthetic)
    expect("kind" in output).toBe(false)
    expect(readSyntheticKind(output)).toBe("refusal-recovery")
    expect(projectParsedSseFrame(output)).toBe(synthetic)
  })

  test("keeps a fresh own ID equal to the source current ID", () => {
    const input = parsed("alpha", { kind: "absent" })
    const output = mapSemanticSseFrame(input, () => ({ event: "replacement", data: "rewritten", id: "alpha" }), "fresh")
    expect(output).toEqual({ event: "replacement", data: "rewritten", id: "alpha" })
    expect("kind" in output).toBe(false)
  })

  test("requires a producer to omit inherited ID when constructing a fresh rewrite", () => {
    const input = parsed("alpha", { kind: "absent" })
    const output = mapSemanticSseFrame(
      input,
      (message) => {
        const { id: _currentId, ...fresh } = message
        return { ...fresh, data: "rewritten" }
      },
      "fresh",
    )
    expect(output).toEqual({ event: "message", data: "rewritten", retry: 0 })
    expect("kind" in output).toBe(false)
  })

  test("keeps synthetic origin when directly projecting a parsed synthetic frame", () => {
    const input = tagFrameSynthetic(parsed("alpha", { kind: "present", value: "alpha" }), "refusal-recovery")
    const projected = projectParsedSseFrame(input)
    expect(projected).toMatchObject({ event: "message", data: "a", id: "alpha", retry: 0 })
    expect(readSyntheticKind(projected)).toBe("refusal-recovery")
  })

  test("rejects a preserve classification that constructs a new frame", () => {
    const input = parsed("alpha", { kind: "absent" })
    expect(() => mapSemanticSseFrame(input, (message) => ({ ...message, data: "changed" }), "preserve")).toThrow(/preserve rewrite/i)
  })

  test("plain constructed frames remain wire-only through projection and mapping", () => {
    const input = { event: "ping", data: "{}", id: "wire" }
    expect(projectParsedSseFrame(input)).toBe(input)
    expect(mapSemanticSseFrame(input, (message) => ({ ...message, data: "changed" }), "fresh")).toEqual({ event: "ping", data: "changed", id: "wire" })
  })
})

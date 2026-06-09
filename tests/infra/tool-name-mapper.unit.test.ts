/**
 * Unit tests for the bidirectional tool-name sanitization mapper.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createToolNameMapper } from "~/lib/tool-name-mapper"

const strict = { allowDots: false, maxNameLength: 64 }
const dotted = { allowDots: true, maxNameLength: 128 }

describe("createToolNameMapper — sanitization", () => {
  test("legal names pass through unchanged", () => {
    const m = createToolNameMapper(["read_file", "write-file", "Tool123"], strict)
    expect(m.toUpstream("read_file")).toBe("read_file")
    expect(m.toUpstream("write-file")).toBe("write-file")
    expect(m.toUpstream("Tool123")).toBe("Tool123")
  })

  test("dots are replaced when allowDots=false", () => {
    const m = createToolNameMapper(["mcp.server.tool"], strict)
    expect(m.toUpstream("mcp.server.tool")).toBe("mcp_server_tool")
  })

  test("dots are preserved when allowDots=true", () => {
    const m = createToolNameMapper(["mcp.server.tool"], dotted)
    expect(m.toUpstream("mcp.server.tool")).toBe("mcp.server.tool")
  })

  test("other illegal chars are replaced and runs collapsed", () => {
    const m = createToolNameMapper(["a b@@c"], strict)
    expect(m.toUpstream("a b@@c")).toBe("a_b_c")
  })

  test("leading/trailing underscores trimmed", () => {
    const m = createToolNameMapper(["__weird!!"], strict)
    expect(m.toUpstream("__weird!!")).toBe("weird")
  })

  test("name that sanitizes to empty becomes 'tool'", () => {
    const m = createToolNameMapper(["!!!"], strict)
    expect(m.toUpstream("!!!")).toBe("tool")
  })
})

describe("createToolNameMapper — truncation", () => {
  test("over-long name is truncated with sha1 suffix and fits the cap", () => {
    const long = "x".repeat(80)
    const m = createToolNameMapper([long], strict)
    const upstream = m.toUpstream(long)
    expect(upstream.length).toBeLessThanOrEqual(strict.maxNameLength)
    expect(upstream).toMatch(/_[0-9a-f]{10}$/)
  })

  test("truncation is deterministic", () => {
    const long = "y".repeat(200)
    const a = createToolNameMapper([long], strict).toUpstream(long)
    const b = createToolNameMapper([long], strict).toUpstream(long)
    expect(a).toBe(b)
  })
})

describe("createToolNameMapper — collision dedup", () => {
  test("two names sanitizing to the same value get distinct upstream names", () => {
    const m = createToolNameMapper(["a.b", "a-b"], strict)
    const u1 = m.toUpstream("a.b")
    const u2 = m.toUpstream("a-b")
    expect(u1).not.toBe(u2)
    // Both round-trip back to their originals.
    expect(m.toClient(u1)).toBe("a.b")
    expect(m.toClient(u2)).toBe("a-b")
  })

  test("deduped names stay within the length cap", () => {
    const base = "z".repeat(60)
    const m = createToolNameMapper([`${base}.a`, `${base}-a`], strict)
    expect(m.toUpstream(`${base}.a`).length).toBeLessThanOrEqual(strict.maxNameLength)
    expect(m.toUpstream(`${base}-a`).length).toBeLessThanOrEqual(strict.maxNameLength)
  })
})

describe("createToolNameMapper — bidirectional round-trip", () => {
  test("toClient reverses toUpstream for mapped names", () => {
    const names = ["read.file", "write@file", "x".repeat(90)]
    const m = createToolNameMapper(names, strict)
    for (const n of names) {
      expect(m.toClient(m.toUpstream(n))).toBe(n)
    }
  })

  test("unknown name to toClient is returned unchanged", () => {
    const m = createToolNameMapper(["a"], strict)
    expect(m.toClient("unknown_upstream")).toBe("unknown_upstream")
  })

  test("unknown name to toUpstream is sanitized deterministically", () => {
    const m = createToolNameMapper(["a"], strict)
    expect(m.toUpstream("b.c")).toBe("b_c")
  })

  test("duplicate original names: first occurrence wins, stable mapping", () => {
    const m = createToolNameMapper(["dup", "dup"], strict)
    expect(m.toUpstream("dup")).toBe("dup")
  })
})

describe("createToolNameMapper — determinism across instances", () => {
  test("same input list yields same mapping", () => {
    const names = ["alpha.one", "beta two", "x".repeat(70)]
    const a = createToolNameMapper(names, strict)
    const b = createToolNameMapper(names, strict)
    for (const n of names) {
      expect(a.toUpstream(n)).toBe(b.toUpstream(n))
    }
  })

  test("allowDots changes the result", () => {
    const withDots = createToolNameMapper(["a.b"], dotted).toUpstream("a.b")
    const noDots = createToolNameMapper(["a.b"], strict).toUpstream("a.b")
    expect(withDots).toBe("a.b")
    expect(noDots).toBe("a_b")
    expect(withDots).not.toBe(noDots)
  })
})

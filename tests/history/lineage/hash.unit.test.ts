import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  computePostResponseHash,
  computeRootHash,
  computeTurnHashes,
  packTurnHashes,
  unpackTurnHashes,
} from "~/lib/history/lineage/hash"

const HEX64 = /^[0-9a-f]{64}$/

describe("computeTurnHashes", () => {
  test("produces one hex hash per input message", () => {
    const msgs = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ] as any
    const h = computeTurnHashes(msgs)
    expect(h).toHaveLength(3)
    for (const hash of h) expect(hash).toMatch(HEX64)
  })

  test("returns [] for empty input", () => {
    expect(computeTurnHashes([])).toEqual([])
  })

  test("is deterministic across calls", () => {
    const msgs = [{ role: "user", content: "hello" }] as any
    const a = computeTurnHashes(msgs)
    const b = computeTurnHashes(msgs)
    expect(a).toEqual(b)
  })

  test("turnHashes[i] is a strict prefix-equality oracle", () => {
    const prefix = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ] as any

    const extended = [...prefix, { role: "user", content: "c" }] as any
    const a = computeTurnHashes(prefix)
    const b = computeTurnHashes(extended)
    expect(b.slice(0, a.length)).toEqual(a)
  })

  test("any change in any earlier message changes all subsequent hashes (cumulative)", () => {
    const a = computeTurnHashes([
      { role: "user", content: "X" },
      { role: "user", content: "Y" },
    ] as any)

    const b = computeTurnHashes([
      { role: "user", content: "X-modified" },
      { role: "user", content: "Y" },
    ] as any)
    expect(a[0]).not.toBe(b[0])
    expect(a[1]).not.toBe(b[1])
  })
})

describe("computePostResponseHash", () => {
  test("postResponseHash equals the (N+1)th turn hash a successor would produce", () => {
    const parentMsgs = [{ role: "user", content: "Q1" }] as any

    const assistantResp = { role: "assistant", content: "A1" } as any

    const childMsgs = [{ role: "user", content: "Q1" }, assistantResp, { role: "user", content: "Q2" }] as any

    const parentTurns = computeTurnHashes(parentMsgs)
    const parentPost = computePostResponseHash(parentTurns, assistantResp)

    const childTurns = computeTurnHashes(childMsgs)

    // The child's turnHashes[parentTurns.length] is the position where the
    // parent's response landed in the child's chain. It must equal parentPost.
    expect(childTurns[parentTurns.length]).toBe(parentPost)
  })

  test("postResponseHash for first-turn (empty turnHashes) seeds with empty string", () => {
    const resp = { role: "assistant", content: "hi" } as any
    // Should not throw, should produce 64-hex.
    const h = computePostResponseHash([], resp)
    expect(h).toMatch(HEX64)
  })
})

describe("computeRootHash", () => {
  test("binds system + tools + msg[0] together", () => {
    const msg0 = { role: "user", content: "hi" } as any
    const a = computeRootHash("system-A", [], msg0)
    const b = computeRootHash("system-B", [], msg0)
    expect(a).not.toBe(b)
  })

  test("identical inputs produce identical root", () => {
    const msg0 = { role: "user", content: "hi" } as any
    expect(computeRootHash("sys", ["t"], msg0)).toBe(computeRootHash("sys", ["t"], msg0))
  })

  test("handles undefined system/tools/msg0 gracefully", () => {
    const h = computeRootHash(undefined, undefined, undefined)
    expect(h).toMatch(HEX64)
  })

  test("different tools produces different root", () => {
    const msg0 = { role: "user", content: "hi" } as any
    const a = computeRootHash("sys", [{ name: "tool_a" }], msg0)
    const b = computeRootHash("sys", [{ name: "tool_b" }], msg0)
    expect(a).not.toBe(b)
  })
})

describe("packTurnHashes / unpackTurnHashes", () => {
  test("round-trips a list of 64-hex hashes", () => {
    const hashes = ["a".repeat(64), "b".repeat(64), "1234567890abcdef".repeat(4)]
    const packed = packTurnHashes(hashes)
    expect(packed.length).toBe(hashes.length * 32)
    expect(unpackTurnHashes(packed)).toEqual(hashes)
  })

  test("empty round-trip", () => {
    expect(unpackTurnHashes(packTurnHashes([]))).toEqual([])
  })

  test("throws on non-multiple-of-32 input", () => {
    expect(() => unpackTurnHashes(Buffer.alloc(33))).toThrow()
  })

  test("throws when packing non-64-hex string", () => {
    expect(() => packTurnHashes(["short"])).toThrow()
  })

  test("works with Uint8Array (not just Buffer)", () => {
    const hashes = ["c".repeat(64)]
    const packed = packTurnHashes(hashes)
    const view = new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength)
    expect(unpackTurnHashes(view)).toEqual(hashes)
  })
})

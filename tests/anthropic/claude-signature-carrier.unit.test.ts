/**
 * Claude-signature carrier — unit tests (Phase 5, RFC 2026-07-14-anthropic-responses-direct-bridge
 * §4.2/§4.4). Byte-exact round-trip is the load-bearing oracle here (exp/anthropic-responses-direct/
 * FINDINGS.md 探针 e: Claude's upstream rejects a signature altered by even ONE byte — a weak
 * "non-empty" assertion would NOT catch a lossy encode/decode bug).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  buildClaudeSignatureCarrier,
  CLAUDE_SIGNATURE_CARRIER_PREFIX,
  extractClaudeSignature,
} from "~/lib/anthropic/claude-signature-carrier"
import { SYNTHETIC_REASONING_SIGNATURE_PREFIX } from "~/lib/anthropic/synthetic-reasoning"

describe("buildClaudeSignatureCarrier / extractClaudeSignature — byte-exact round-trip (load-bearing oracle)", () => {
  test("a real-shaped Claude signature round-trips byte-exact through the carrier", () => {
    // A realistic-shaped signature (base64 blob, matches the general shape observed in probe (e)).
    const realSignature =
      "EpICCokBCA8YAipAkdxBdM3kLmY5kjjU5zOzASAQcL3DFFfb2jejUZOPjuJrMtaWdV77O5dZQCe6TEwRUbfCexFp39fpi0cd4ykzlDIPY2xhdWRlLW9wdXMtNC04OABCCHRoaW5raW5nWiRjZWQxZjk4ZS0wYjUxLTQ2MTAtODI4Mi00ZTVkODgzODQ1NzQSDOs7RCuEB888OvuLNhoM3xA3Q2NqM5+1orROIjCe3TDVg0QV+sqXfUrhxYebYTWPknMSB3iCL160MLikP+K0wU9w6tWedTxyog121S8qNjVdBnPMoozhFNYKLKsPeEyEYB+zdGg05tT61eIEdiwvcsghbPUaikuA3KefU4ufD6pD8xfldxgB"
    const carrier = buildClaudeSignatureCarrier(realSignature)
    expect(carrier).toBeDefined()
    const recovered = extractClaudeSignature(carrier)
    // Byte-exact — not just "truthy" / "same length" — matches the actual failure mode probe (e) found
    // (a single altered character → upstream 400).
    expect(recovered).toBe(realSignature)
  })

  test("a signature containing characters unsafe for a bare wire string (slashes, plus, equals) still round-trips exactly", () => {
    const weird = "abc/def+ghi==jkl///+++===END"
    const carrier = buildClaudeSignatureCarrier(weird)
    expect(extractClaudeSignature(carrier)).toBe(weird)
  })

  test("undefined signature → undefined carrier (no hollow envelope emitted)", () => {
    expect(buildClaudeSignatureCarrier(undefined)).toBeUndefined()
  })

  test("empty-string signature → undefined carrier", () => {
    expect(buildClaudeSignatureCarrier("")).toBeUndefined()
  })

  test("carrier is stamped with the CLAUDE_SIGNATURE_CARRIER_PREFIX, distinguishable on the wire", () => {
    const carrier = buildClaudeSignatureCarrier("sig")
    expect(carrier).toStartWith(CLAUDE_SIGNATURE_CARRIER_PREFIX)
  })
})

describe("extractClaudeSignature — never throws, never confuses a foreign/absent carrier for a real one", () => {
  test("absent (undefined) → undefined", () => {
    expect(extractClaudeSignature(undefined)).toBeUndefined()
  })

  test("a plain non-carrier string → undefined", () => {
    expect(extractClaudeSignature("just some random string")).toBeUndefined()
  })

  test("a non-string value (number/object) → undefined, never throws", () => {
    expect(extractClaudeSignature(42)).toBeUndefined()
    expect(extractClaudeSignature({ foo: "bar" })).toBeUndefined()
  })

  test("bare prefix with no payload → undefined", () => {
    expect(extractClaudeSignature(CLAUDE_SIGNATURE_CARRIER_PREFIX)).toBeUndefined()
  })

  test("corrupt base64url payload after the prefix never throws (Buffer.from base64url is a lenient decoder — it does not raise on invalid chars, unlike a strict base64 decoder; the important property is NO EXCEPTION, not a specific return shape)", () => {
    expect(() => extractClaudeSignature(`${CLAUDE_SIGNATURE_CARRIER_PREFIX}!!!not-valid-base64!!!`)).not.toThrow()
  })

  test("R-DIRECTION-ASYMMETRY: a FORWARD-leg synthetic-reasoning sentinel is NOT recognized as a Claude-signature carrier (the two prefixes are mutually exclusive)", () => {
    expect(CLAUDE_SIGNATURE_CARRIER_PREFIX).not.toBe(SYNTHETIC_REASONING_SIGNATURE_PREFIX)
    const foreignCarrier = `${SYNTHETIC_REASONING_SIGNATURE_PREFIX}${Buffer.from("gpt-encrypted-content", "utf8").toString("base64url")}`
    expect(extractClaudeSignature(foreignCarrier)).toBeUndefined()
  })
})

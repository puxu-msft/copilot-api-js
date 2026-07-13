/**
 * C1 — CellAssembly contract + L1 existence guard (RFC 2026-07-13 §11.6/§11.8).
 *
 * The two records ({@link OUTBOUND_LEGS} by targetEndpoint, {@link RETRY_SEMANTICS} by clientFormat) are
 * EXHAUSTIVE over their key type — a missing cell is a COMPILE error (the Phase-7 "switch missing case →
 * default throw → silent 500" class, eliminated at the type level). This test is the RUNTIME L1 guard:
 *   - every (cf × te) cell resolves to a CellAssembly carrying the right axes (structural),
 *   - C1 has migrated NO leg (`MIGRATED_LEGS` empty → the driver's hybrid dispatch, added in C2, always
 *     takes the legacy path → byte-identical), and
 *   - the C1 placeholder leg/semantics throw a LOUD, identifiable error when invoked (never a silent
 *     wrong-wire) — this is what C2-C4 replace, and each migrated cell then adds its own "buildStrategies
 *     is non-empty + does not throw" assertion here (the direct Phase-7 guard, RFC §11.8).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ClientFormat,
  RequestEnvelope,
  UpstreamEndpoint,
} from "~/lib/pipeline/envelope"

import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  MIGRATED_LEGS,
  OUTBOUND_LEGS,
  RETRY_SEMANTICS,
  isLegMigrated,
  resolveCellAssembly,
} from "~/lib/pipeline/cell-assembly"

const ALL_CLIENT_FORMATS: ReadonlyArray<ClientFormat> = ["anthropic", "openai-cc", "openai-responses", "gemini"]
const ALL_LEGS: ReadonlyArray<UpstreamEndpoint> = [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.RESPONSES, ENDPOINT.WS_RESPONSES]

/** A minimal env stub carrying just the two routing axes (the placeholder paths throw before reading more). */
function envStub(clientFormat: ClientFormat, targetEndpoint: UpstreamEndpoint): RequestEnvelope {
  return { clientFormat, targetEndpoint } as unknown as RequestEnvelope
}

describe("C1 — CellAssembly exhaustive records + L1 existence guard", () => {
  test("both records are total over their key type (a resolve for every cell)", () => {
    // The exhaustiveness itself is a COMPILE guard (Record<ClientFormat|UpstreamEndpoint, …>); this asserts
    // every key is present at runtime too (a defensive check against an accidental `as` cast erasing it).
    expect(Object.keys(RETRY_SEMANTICS).sort()).toEqual([...ALL_CLIENT_FORMATS].sort())
    expect(Object.keys(OUTBOUND_LEGS).sort()).toEqual([...ALL_LEGS].sort())
  })

  test("resolveCellAssembly returns the right axes for every (cf × te) cell", () => {
    for (const cf of ALL_CLIENT_FORMATS) {
      for (const te of ALL_LEGS) {
        const cell = resolveCellAssembly(cf, te)
        expect(cell.clientFormat).toBe(cf)
        expect(cell.targetEndpoint).toBe(te)
      }
    }
  })

  test("C1: no leg migrated yet — the hybrid dispatch always takes the legacy path", () => {
    expect(MIGRATED_LEGS.size).toBe(0)
    for (const te of ALL_LEGS) expect(isLegMigrated(te)).toBe(false)
  })

  test("C1 placeholders throw a LOUD identifiable error (never a silent wrong-wire)", () => {
    // The wire leg placeholder throws when a method is invoked.
    expect(() => OUTBOUND_LEGS[ENDPOINT.MESSAGES].prepareWire(envStub("anthropic", ENDPOINT.MESSAGES))).toThrow(/has not migrated yet/)
    // The retry-semantics placeholder throws when evaluated against env.
    expect(() => RETRY_SEMANTICS.anthropic(envStub("anthropic", ENDPOINT.MESSAGES))).toThrow(/has not migrated yet/)
    // buildStrategies composes both → also throws (the Phase-7 guard surface, non-empty asserted per cell in C2+).
    expect(() => resolveCellAssembly("anthropic", ENDPOINT.MESSAGES).buildStrategies(envStub("anthropic", ENDPOINT.MESSAGES))).toThrow(/has not migrated yet/)
  })
})

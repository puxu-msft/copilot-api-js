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

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  MIGRATED_CELLS,
  OUTBOUND_LEGS,
  RETRY_SEMANTICS,
  isCellMigrated,
  resolveCellAssembly,
} from "~/lib/pipeline/cell-assembly"

import { mockModel } from "../helpers/factories"

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

  test("C2a: only the anthropic|/v1/messages cell is migrated (cell-keyed shim, no double-active)", () => {
    expect(MIGRATED_CELLS.has("anthropic|/v1/messages")).toBe(true)
    expect(isCellMigrated("anthropic", ENDPOINT.MESSAGES)).toBe(true)
    // The 3 REVERSE @messages cells sharing the /v1/messages leg are NOT migrated yet (C2b) — the
    // cell-keyed shim keeps them on the legacy path (no double-active on the shared leg).
    for (const cf of ["openai-cc", "openai-responses", "gemini"] as const) expect(isCellMigrated(cf, ENDPOINT.MESSAGES)).toBe(false)
    // No forward/direct cell on the other legs is migrated (C3/C4).
    for (const te of [ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.RESPONSES, ENDPOINT.WS_RESPONSES]) expect(isCellMigrated("anthropic", te)).toBe(false)
  })

  test("unmigrated cells throw a LOUD identifiable error (never a silent wrong-wire)", () => {
    // A not-yet-migrated LEG (openai-cc /chat/completions cell) throws when a method is invoked.
    expect(() => OUTBOUND_LEGS[ENDPOINT.CHAT_COMPLETIONS].prepareWire(envStub("openai-cc", ENDPOINT.CHAT_COMPLETIONS))).toThrow(/has not migrated yet/)
    // The reverse @messages cell (openai-cc → /v1/messages) throws (C2b) even though the leg exists (C2a anthropic).
    expect(() => OUTBOUND_LEGS[ENDPOINT.MESSAGES].translateOut(envStub("openai-cc", ENDPOINT.MESSAGES))).toThrow(/has not migrated yet \(C2b\)/)
    // The retry-semantics for a not-yet-migrated client format throws.
    expect(() => RETRY_SEMANTICS["openai-cc"](envStub("openai-cc", ENDPOINT.CHAT_COMPLETIONS))).toThrow(/has not migrated yet/)
  })

  test("the migrated anthropic|/v1/messages cell resolves to a live semantics spec (auto-truncate on)", () => {
    // RETRY_SEMANTICS for the MIGRATED cell returns a real spec (not a throw): auto-truncate in the stack.
    const spec = RETRY_SEMANTICS.anthropic(envStub("anthropic", ENDPOINT.MESSAGES))
    expect(spec.autoTruncate).toBe(true)
    expect(spec.maxRetries).toBeGreaterThanOrEqual(0)
    expect(spec.label).toBe("Anthropic")
  })

  test("L1 (Phase-7 guard): the migrated anthropic|/v1/messages cell's buildStrategies is NON-EMPTY + does not throw", () => {
    // The exact Phase-7 bug class ("missing builder → silent 500"): a migrated cell MUST produce a
    // non-empty strategy stack. Build a real env carrying the leg supply on requestState (what parse sets).
    const env = {
      clientFormat: "anthropic" as const,
      targetEndpoint: ENDPOINT.MESSAGES,
      model: mockModel("claude-opus-4.8", { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES] }),
      body: { model: "claude-opus-4.8", max_tokens: 100, messages: [] },
      prepareHints: {},
      requestState: {
        betaProbe: createBetaProbe(undefined),
        truncateBaseline: { model: "claude-opus-4.8", max_tokens: 100, messages: [] },
        resanitize: ((p: unknown) => p) as unknown,
      },
    } as unknown as RequestEnvelope
    const strategies = resolveCellAssembly("anthropic", ENDPOINT.MESSAGES).buildStrategies(env)
    expect(strategies.length).toBeGreaterThan(0)
    for (const s of strategies) expect(typeof s.name).toBe("string")
  })
})

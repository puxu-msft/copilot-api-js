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

  test("C2/C3 migration set: all 4 /v1/messages cells + the 3 CC-shaped /chat cells; NOT the responses-fallback /chat, /responses, ws", () => {
    // C2a (anthropic direct) + C2b (the 3 reverse @messages cells) — the whole /v1/messages leg.
    for (const cf of ["anthropic", "openai-cc", "openai-responses", "gemini"] as const) {
      expect(isCellMigrated(cf, ENDPOINT.MESSAGES)).toBe(true)
      expect(MIGRATED_CELLS.has(`${cf}|/v1/messages`)).toBe(true)
    }
    // C3: the 3 CC-shaped /chat/completions cells (openai-cc DIRECT + anthropic/gemini FORWARD @cc).
    for (const cf of ["openai-cc", "anthropic", "gemini"] as const) expect(isCellMigrated(cf, ENDPOINT.CHAT_COMPLETIONS)).toBe(true)
    // The (openai-responses, /chat) FALLBACK cell is NOT migrated yet (C4 — its wire is the Responses→CC fallback).
    expect(isCellMigrated("openai-responses", ENDPOINT.CHAT_COMPLETIONS)).toBe(false)
    // No cell on the /responses + ws legs is migrated yet (C4).
    for (const te of [ENDPOINT.RESPONSES, ENDPOINT.WS_RESPONSES]) {
      for (const cf of ["anthropic", "openai-cc", "openai-responses", "gemini"] as const) expect(isCellMigrated(cf, te)).toBe(false)
    }
  })

  test("R1/HIGH-A corner: (openai-responses, /v1/messages) has auto-truncate ON — not a clientFormat scalar", () => {
    // The corner that breaks BOTH single-axis scalars: the openai-responses REVERSE @messages cell has
    // auto-truncate ON (Anthropic stack), while its DIRECT /responses cell has it OFF (C4). RETRY_SEMANTICS
    // reads env.targetEndpoint to pick — proving it is a 2D function, not a clientFormat scalar.
    expect(RETRY_SEMANTICS["openai-responses"](envStub("openai-responses", ENDPOINT.MESSAGES)).autoTruncate).toBe(true)
    // Its DIRECT /responses cell is not migrated yet (C4) → still throws (the auto-truncate-OFF corner lands there).
    expect(() => RETRY_SEMANTICS["openai-responses"](envStub("openai-responses", ENDPOINT.RESPONSES))).toThrow(/has not migrated yet/)
    // Symmetry: cc + gemini reverse @messages also have auto-truncate ON.
    expect(RETRY_SEMANTICS["openai-cc"](envStub("openai-cc", ENDPOINT.MESSAGES)).autoTruncate).toBe(true)
    expect(RETRY_SEMANTICS.gemini(envStub("gemini", ENDPOINT.MESSAGES)).autoTruncate).toBe(true)
  })

  test("C3 semantics: the 3 CC-shaped /chat cells have auto-truncate ON + distinct labels", () => {
    // openai-cc DIRECT + anthropic/gemini FORWARD @cc all run the CC stack (auto-truncate ON), differing
    // only in the console label. The (openai-responses, /chat) fallback is NOT here (auto-truncate OFF, C4).
    const cc = RETRY_SEMANTICS["openai-cc"](envStub("openai-cc", ENDPOINT.CHAT_COMPLETIONS))
    expect(cc.autoTruncate).toBe(true)
    expect(cc.label).toBe("Completions")
    expect(RETRY_SEMANTICS.anthropic(envStub("anthropic", ENDPOINT.CHAT_COMPLETIONS)).label).toBe("Anthropic(→CC)")
    expect(RETRY_SEMANTICS.gemini(envStub("gemini", ENDPOINT.CHAT_COMPLETIONS)).label).toBe("Gemini")
    // The responses-fallback /chat cell stays legacy → still throws (auto-truncate-OFF corner lands in C4).
    expect(() => RETRY_SEMANTICS["openai-responses"](envStub("openai-responses", ENDPOINT.CHAT_COMPLETIONS))).toThrow(/has not migrated yet/)
  })

  test("unmigrated cells throw a LOUD identifiable error (never a silent wrong-wire)", () => {
    // A not-yet-migrated LEG (the /responses leg) throws when a method is invoked.
    expect(() => OUTBOUND_LEGS[ENDPOINT.RESPONSES].prepareWire(envStub("openai-responses", ENDPOINT.RESPONSES))).toThrow(/has not migrated yet/)
    // The retry-semantics for a not-yet-migrated cell (openai-responses DIRECT /responses) throws.
    expect(() => RETRY_SEMANTICS["openai-responses"](envStub("openai-responses", ENDPOINT.RESPONSES))).toThrow(/has not migrated yet/)
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

  test("L1 (Phase-7 guard): the 3 migrated /chat/completions cells' buildStrategies are NON-EMPTY + do not throw", () => {
    // C3's direct Phase-7 guard: openai-cc DIRECT + anthropic/gemini FORWARD @cc must each produce a
    // non-empty CC strategy stack. env.body is CC-shaped for all three (direct native; forward hub-translated
    // — here we hand a CC body directly, which is what the leg's buildLegStrategies reads). requestState
    // carries the truncateBaseline the cc/gemini legs read.
    const ccBody = { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }
    for (const cf of ["openai-cc", "anthropic", "gemini"] as const) {
      const env = {
        clientFormat: cf,
        targetEndpoint: ENDPOINT.CHAT_COMPLETIONS,
        model: mockModel("gpt-5.5", { vendor: "OpenAI", supported_endpoints: [ENDPOINT.CHAT_COMPLETIONS] }),
        body: ccBody,
        prepareHints: {},
        requestState: { truncateBaseline: ccBody },
      } as unknown as RequestEnvelope
      const strategies = resolveCellAssembly(cf, ENDPOINT.CHAT_COMPLETIONS).buildStrategies(env)
      expect(strategies.length).toBeGreaterThan(0)
      for (const s of strategies) expect(typeof s.name).toBe("string")
    }
  })
})

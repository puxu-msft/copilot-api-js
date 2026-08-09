/**
 * Unit tests for `shapePostcommitErrorFrame` (Phase 3 Task 3.2, G-3 canonical ownership of the
 * post-commit terminal error frame — docs/plan/2026-07-13-upstream-error-client-shaping/phase-3-postcommit-canonical-frame.md).
 *
 * Pure helper: classify → decide(post-commit) → buildCanonicalErrorFrame, with a CF-2 golden lock
 * (disabled = return the caller's legacy frame verbatim). No Hono app / no runtime bootstrap;
 * `autoRestoreState()` is the isolation tool (mirrors `error-shaping-glue.unit.test.ts`).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ClientFrame } from "~/lib/pipeline/types"

import { HTTPError } from "~/lib/error"
import { readSyntheticKind } from "~/lib/pipeline/frame-origin"
import { setStateForTests } from "~/lib/state"

import {
  //
  shapePostcommitErrorFrame,
  shapeRawStreamErrorFrame,
} from "../../../src/routes/messages/error-shaping-glue"
import {
  //
  anthropicErrorFrame,
  anthropicHttpErrorFrame,
} from "../../../src/routes/messages/post-commit-error"
import { autoRestoreState } from "../../helpers/state-fixture"

describe("shapePostcommitErrorFrame — CF-2 golden lock (disabled)", () => {
  autoRestoreState()

  test("errorShapingEnabled=false → returns the caller's legacy HTTPError frame verbatim (byte-identical)", () => {
    setStateForTests({ errorShapingEnabled: false })
    const error = new HTTPError("Unauthorized", 401, JSON.stringify({ type: "error", error: { type: "authentication_error", message: "mock 401" } }))
    const legacy = anthropicHttpErrorFrame(error)
    const out = shapePostcommitErrorFrame(error, legacy)
    expect(out).toEqual(legacy)
    expect(out.data).toBe(legacy.data) // exact same string bytes
  })

  test("errorShapingEnabled=false → returns the caller's legacy unknown-non-HTTP frame verbatim (terminus ①')", () => {
    setStateForTests({ errorShapingEnabled: false })
    const error = new Error("socket hang up ECONNRESET")
    const legacy = anthropicErrorFrame("api_error", error.message)
    const out = shapePostcommitErrorFrame(error, legacy)
    expect(out).toEqual(legacy)
  })
})

describe("shapePostcommitErrorFrame — enabled (canonical via decide)", () => {
  autoRestoreState()

  test("terminus ①' network_error (socket reset) → decide() reached → canonical api_error frame (proves the truth-table network_error→canonical-error leg is exercised, not the old hand-built branch)", () => {
    setStateForTests({ errorShapingEnabled: true })
    const error = new Error("socket hang up ECONNRESET")
    // legacy would have been api_error too, so byte-equivalence here isn't the point — the point is
    // this frame is produced by decide()/buildCanonicalErrorFrame, not the hand-built literal.
    const out = shapePostcommitErrorFrame(error, anthropicErrorFrame("api_error", "SENTINEL-legacy-untouched"))
    const data = JSON.parse(out.data ?? "{}") as { type: string; error: { type: string; message: string } }
    expect(data.type).toBe("error")
    expect(data.error.type).toBe("api_error") // anthropicErrorTypeForApiError("network_error")
    expect(data.error.message).toContain("socket hang up")
    expect(data.error.message).not.toBe("SENTINEL-legacy-untouched") // legacy frame NOT returned
  })

  test("terminus ①' HTTP2 REFUSED_STREAM → network_error → canonical api_error frame", () => {
    setStateForTests({ errorShapingEnabled: true })
    const error = new Error("Stream closed with error code NGHTTP2_REFUSED_STREAM")
    const out = shapePostcommitErrorFrame(error, anthropicErrorFrame("api_error", "x"))
    const data = JSON.parse(out.data ?? "{}") as { error: { type: string } }
    expect(data.error.type).toBe("api_error")
  })

  test("terminus ① 402 quota_exceeded HTTPError → canonical rate_limit_error (CF-3 wire literal), retry_after carried when present", () => {
    setStateForTests({ errorShapingEnabled: true })
    const error = new HTTPError("Quota exceeded", 402, JSON.stringify({ error: { message: "quota", retry_after: 30 } }))
    const out = shapePostcommitErrorFrame(error, anthropicHttpErrorFrame(error))
    const data = JSON.parse(out.data ?? "{}") as { type: string; error: { type: string; message: string; retry_after?: number } }
    expect(data.type).toBe("error")
    expect(data.error.type).toBe("rate_limit_error") // anthropicErrorTypeForApiError("quota_exceeded") — CF-3
    expect(data.error.retry_after).toBe(30)
  })

  test("terminus ① 500 server_error HTTPError → canonical api_error frame", () => {
    setStateForTests({ errorShapingEnabled: true })
    const error = new HTTPError("Server error", 500, "")
    const out = shapePostcommitErrorFrame(error, anthropicHttpErrorFrame(error))
    const data = JSON.parse(out.data ?? "{}") as { error: { type: string } }
    expect(data.error.type).toBe("api_error") // anthropicErrorTypeForApiError("server_error")
  })
})

describe("shapeRawStreamErrorFrame — FIX-2 (H3 / truncation termini, direct pump + translate leg)", () => {
  autoRestoreState()

  test("enabled → buildCanonicalErrorFrame({errorType, message}) is byte-identical to the legacy hand-built literal", () => {
    setStateForTests({ errorShapingEnabled: true })
    // The former hand-built literal both pumps emitted for H3 / truncation.
    const legacy: ClientFrame = { event: "error", data: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "boom" } }) }
    const out = shapeRawStreamErrorFrame("overloaded_error", "boom", legacy)
    // WIRE byte-identity (event + data) — the intentional Symbol provenance tag (§B.2) is NOT wire and
    // is deliberately excluded (bun's toEqual would otherwise see the Symbol key; CF-2 locks wire bytes).
    expect({ event: out.event, data: out.data }).toEqual({ event: legacy.event, data: legacy.data })
  })

  test("enabled → truncation frame byte-identical to the legacy literal (both pumps' truncation message)", () => {
    setStateForTests({ errorShapingEnabled: true })
    const msg = "Upstream stream truncated before completion (no message_stop)"
    const legacy: ClientFrame = { event: "error", data: JSON.stringify({ type: "error", error: { type: "api_error", message: msg } }) }
    const out = shapeRawStreamErrorFrame("api_error", msg, legacy)
    expect({ event: out.event, data: out.data }).toEqual({ event: legacy.event, data: legacy.data })
  })

  test("DISABLED → returns the caller's legacy frame verbatim (CF-2 golden lock, uniform with ①/①')", () => {
    setStateForTests({ errorShapingEnabled: false })
    const legacy: ClientFrame = { event: "error", data: JSON.stringify({ type: "error", error: { type: "timeout_error", message: "idle" } }) }
    const out = shapeRawStreamErrorFrame("timeout_error", "idle", legacy)
    expect(out).toBe(legacy) // same object reference — no rebuild at all when disabled
  })

  // Unit 3 §B.2: the canonical frame is tagged `synthetic:"error-shaping-canonical"` so it stays
  // distinguishable from a real upstream error frame on the forwarded history track (via writeSynthetic
  // now reading readSyntheticKind, §B.1). The tag is a Symbol — invisible to the byte-identical
  // `toEqual` assertions above (which only compare enumerable string keys), so the wire is unchanged.
  test("enabled → the canonical frame carries synthetic:'error-shaping-canonical' (forwarded-track distinguishability)", () => {
    setStateForTests({ errorShapingEnabled: true })
    const legacy: ClientFrame = { event: "error", data: JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }) }
    expect(readSyntheticKind(shapeRawStreamErrorFrame("api_error", "boom", legacy))).toBe("error-shaping-canonical")
  })

  test("DISABLED → legacy frame is NOT tagged (CF-2: off = exact legacy bytes, no marker)", () => {
    setStateForTests({ errorShapingEnabled: false })
    const legacy: ClientFrame = { event: "error", data: JSON.stringify({ type: "error", error: { type: "timeout_error", message: "idle" } }) }
    expect(readSyntheticKind(shapeRawStreamErrorFrame("timeout_error", "idle", legacy))).toBeUndefined()
  })

  // Unit 3 §B.3: dedicated telemetry dimension for the 4 raw-stream canonical termini. `wireErrorType`
  // is a wire string (NOT the ApiErrorType enum of error-shaping-decided — same name would mix value
  // domains across FeatureKinds). Recorded INSIDE shapeRawStreamErrorFrame → before writeSynthetic
  // returns → before ctx.fail freezes the entry (ordering satisfied by construction).
  test("enabled + ctx + meta → records error-shaping-raw-canonical{wireErrorType, terminus, leg}", () => {
    setStateForTests({ errorShapingEnabled: true })
    const features: Array<{ feature: string; detail?: Record<string, unknown> }> = []
    const ctx = { recordFeature: (feature: string, detail?: Record<string, unknown>) => features.push({ feature, detail }) }
    const legacy: ClientFrame = { event: "error", data: "{}" }
    shapeRawStreamErrorFrame("overloaded_error", "boom", legacy, ctx as never, { terminus: "stream-error", leg: "direct" })
    expect(features).toEqual([
      { feature: "error-shaping-raw-canonical", detail: { wireErrorType: "overloaded_error", terminus: "stream-error", leg: "direct" } },
    ])
  })

  test("enabled + ctx + meta (translate truncation) → records leg=translate, terminus=truncation", () => {
    setStateForTests({ errorShapingEnabled: true })
    const features: Array<{ feature: string; detail?: Record<string, unknown> }> = []
    const ctx = { recordFeature: (feature: string, detail?: Record<string, unknown>) => features.push({ feature, detail }) }
    shapeRawStreamErrorFrame("api_error", "trunc", { event: "error", data: "{}" }, ctx as never, { terminus: "truncation", leg: "translate" })
    expect(features).toEqual([{ feature: "error-shaping-raw-canonical", detail: { wireErrorType: "api_error", terminus: "truncation", leg: "translate" } }])
  })

  test("CF-2 disabled → error-shaping-raw-canonical NOT recorded even when ctx+meta passed (no canonical shaping happened)", () => {
    setStateForTests({ errorShapingEnabled: false })
    const features: Array<{ feature: string; detail?: Record<string, unknown> }> = []
    const ctx = { recordFeature: (feature: string, detail?: Record<string, unknown>) => features.push({ feature, detail }) }
    shapeRawStreamErrorFrame("timeout_error", "idle", { event: "error", data: "{}" }, ctx as never, { terminus: "stream-error", leg: "direct" })
    expect(features).toEqual([])
  })

  test("ctx/meta omitted (backward-compat) → does not throw", () => {
    setStateForTests({ errorShapingEnabled: true })
    expect(() => shapeRawStreamErrorFrame("api_error", "x", { event: "error", data: "{}" })).not.toThrow()
  })
})

// ============================================================================
// FIX-OBS-2 (whole-branch review cross-phase gap): `error-shaping-decided` was declared in
// FeatureKind but had ZERO production call sites for the post-commit `decide()` invocation
// (`shapePostcommitErrorFrame`). `ctx` is an OPTIONAL 3rd param (both existing call sites in
// `handler-v4.ts` already hold `codec.getContext()` in scope — see task report) so every existing
// call site + test keeps compiling; recording is a no-op when omitted (`ctx?.recordFeature`).
//
// `shapeRawStreamErrorFrame` deliberately does NOT gain this wiring: it never calls `decide()` (no
// `ApiError` classification — the caller already resolved a wire-level `errorType` string that is
// NOT an `ApiErrorType`), so there is no `decide()` decision to report — see task report for the
// full reasoning.
// ============================================================================
describe("shapePostcommitErrorFrame — recordFeature('error-shaping-decided') wiring (FIX-OBS-2)", () => {
  autoRestoreState()

  function fakeCtx() {
    const features: Array<{ feature: string; detail?: Record<string, unknown> }> = []
    const ctx = { recordFeature: (feature: string, detail?: Record<string, unknown>) => features.push({ feature, detail }) }
    return { ctx: ctx as never, features }
  }

  test("enabled + terminus ① HTTPError → records error-shaping-decided(decision=canonical-error, commitPhase=post-commit)", () => {
    setStateForTests({ errorShapingEnabled: true })
    const { ctx, features } = fakeCtx()
    const error = new HTTPError("Server error", 500, "")
    shapePostcommitErrorFrame(error, anthropicHttpErrorFrame(error), ctx)
    expect(features).toEqual([
      { feature: "error-shaping-decided", detail: { decision: "canonical-error", errorType: "server_error", commitPhase: "post-commit" } },
    ])
  })

  test("enabled + terminus ①' network_error (socket reset) → records error-shaping-decided with errorType=network_error", () => {
    setStateForTests({ errorShapingEnabled: true })
    const { ctx, features } = fakeCtx()
    const error = new Error("socket hang up ECONNRESET")
    shapePostcommitErrorFrame(error, anthropicErrorFrame("api_error", "x"), ctx)
    expect(features).toEqual([
      { feature: "error-shaping-decided", detail: { decision: "canonical-error", errorType: "network_error", commitPhase: "post-commit" } },
    ])
  })

  test("CF-2 disabled → decide() never runs → error-shaping-decided NOT recorded even when ctx is passed", () => {
    setStateForTests({ errorShapingEnabled: false })
    const { ctx, features } = fakeCtx()
    const error = new HTTPError("Server error", 500, "")
    shapePostcommitErrorFrame(error, anthropicHttpErrorFrame(error), ctx)
    expect(features).toEqual([])
  })

  test("ctx omitted (backward-compat) → does not throw, ctx?.recordFeature is a safe no-op", () => {
    setStateForTests({ errorShapingEnabled: true })
    const error = new HTTPError("Server error", 500, "")
    expect(() => shapePostcommitErrorFrame(error, anthropicHttpErrorFrame(error))).not.toThrow()
  })
})

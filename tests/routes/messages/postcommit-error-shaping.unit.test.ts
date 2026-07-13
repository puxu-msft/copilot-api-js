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

import { HTTPError } from "~/lib/error"
import { setStateForTests } from "~/lib/state"

import { shapePostcommitErrorFrame } from "../../../src/routes/messages/error-shaping-glue"
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

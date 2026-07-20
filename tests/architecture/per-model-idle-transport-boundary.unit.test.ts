/**
 * Reverse guard for ADR 2026-07-12-per-model-idle-timeout-is-app-guard-only.
 *
 * per-model idle timeout is APP-GUARD-only: the override maps
 * (`streamIdleTimeoutOverrides` / `responseHeaderTimeoutOverrides`) must NEVER be
 * read in the transport layer (undici dispatcher / node:http2 client). GHC(https)
 * rides node:http2 with `sock.setTimeout(0)` (no transport body-idle); undici only
 * serves plaintext SearXNG on the SCALAR `state.streamIdleTimeout`. Coupling the
 * global backstop to per-model overrides would guard a path gpt-5.5 never takes.
 *
 * This guard catches any future "read the per-model override in the transport
 * layer" regression. It deliberately matches only the OVERRIDE field names — the
 * scalar `state.streamIdleTimeout` legitimately appears in proxy.ts:105
 * (undici bodyTimeout for SearXNG, spec §7.3 keeps it) and MUST NOT be flagged.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const TRANSPORT_FILES = ["../../src/lib/proxy.ts", "../../src/lib/transport/http2-client.ts"] as const

// Only the per-model OVERRIDE field names — NOT the scalar `streamIdleTimeout`
// (proxy.ts:105 legitimately reads the scalar for the SearXNG undici bodyTimeout).
const OVERRIDE_FIELD = /streamIdleTimeoutOverrides|responseHeaderTimeoutOverrides/

describe("per-model idle timeout transport boundary (ADR reverse guard)", () => {
  for (const rel of TRANSPORT_FILES) {
    test(`${rel} does not read per-model timeout overrides`, () => {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
      expect(OVERRIDE_FIELD.test(src)).toBe(false)
    })
  }

  test("guard is live — the override field regex actually matches when present", () => {
    // Positive control: prove the guard would fail on a real violation, so a
    // passing guard means "no override in transport", not "regex never matches".
    expect(OVERRIDE_FIELD.test("state.streamIdleTimeoutOverrides")).toBe(true)
    // And the scalar is intentionally NOT matched (proxy.ts:105 stays legal).
    expect(OVERRIDE_FIELD.test("scaleTimeout(state.streamIdleTimeout)")).toBe(false)
  })
})

/**
 * Guard tests for GET /api/config — the effective runtime config snapshot.
 *
 * The endpoint derives hot-reloadable fields automatically from the
 * authoritative `CONFIG_MANAGED_DEFAULTS` key set (replacing a hand-maintained
 * allowlist that silently drifted and omitted web_search /
 * thinking_signature_compat / etc.). These tests lock that contract:
 *   1. Completeness — every CONFIG_MANAGED_DEFAULTS key is exposed (verbatim,
 *      renamed, or as a `<key>Set` boolean). A new field added there with no
 *      handling fails this test.
 *   2. Secrecy — secret values (anthropicApiKey) are never emitted verbatim.
 *   3. Regression — the fields that were previously missing are now present.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { CONFIG_MANAGED_DEFAULTS } from "~/lib/state"

import { createFullTestApp } from "../helpers/test-app"

const app = createFullTestApp()

/**
 * CONFIG_MANAGED_DEFAULTS keys that appear under a different output key.
 * Keeping this explicit (rather than inferred) makes the contract auditable.
 */
const RENAMED_KEYS: Record<string, string> = {
  // Secret → boolean presence flag (value never emitted).
  anthropicApiKey: "anthropicApiKeySet",
  // Compiled RegExp rules → count.
  systemPromptOverrides: "systemPromptOverridesCount",
}

async function getConfig(): Promise<Record<string, unknown>> {
  const res = await app.request("/api/config")
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

describe("GET /api/config — effective config snapshot", () => {
  test("completeness: every CONFIG_MANAGED_DEFAULTS key is exposed or explicitly renamed", async () => {
    const body = await getConfig()
    const exposed = new Set(Object.keys(body))

    const missing: Array<string> = []
    for (const key of Object.keys(CONFIG_MANAGED_DEFAULTS)) {
      const expected = RENAMED_KEYS[key] ?? key
      if (!exposed.has(expected)) missing.push(`${key} (expected output key: ${expected})`)
    }

    // A new field added to CONFIG_MANAGED_DEFAULTS with no handling in the route
    // lands here — the auto-derive means it should appear verbatim, so this only
    // fails if someone breaks the derive loop or adds a field needing a rename.
    expect(missing).toEqual([])
  })

  test("secrecy: anthropicApiKey value is never emitted; exposed only as a boolean flag", async () => {
    const body = await getConfig()
    expect("anthropicApiKey" in body).toBe(false)
    expect(typeof body.anthropicApiKeySet).toBe("boolean")
  })

  test("secret-named guard: no credential-looking field is emitted verbatim (defends against a NEW secret bypassing SENSITIVE)", async () => {
    // The completeness test only checks a key is PRESENT, not that it is masked.
    // So a new secret added to CONFIG_MANAGED_DEFAULTS but forgotten in
    // SENSITIVE_CONFIG_KEYS would be auto-emitted verbatim AND pass completeness.
    // This guard closes that hole structurally: any output key whose NAME looks
    // like a credential must be a masked `<key>Set` flag, not a raw value.
    const body = await getConfig()
    const SECRET_NAME = /key|token|secret|password|credential/i
    // Fields whose name matches the pattern but are NOT secrets (booleans/flags).
    // Adding here is a deliberate, reviewable exemption; the failure mode is a
    // false positive (test fails), never a silent leak.
    const NON_SECRET_DESPITE_NAME = new Set<string>([
      "tokenBasedBilling", // billing mode flag, not a credential
      "showGitHubToken", // whether to log the token, not the token itself
    ])
    const leaked = Object.keys(body).filter((k) => SECRET_NAME.test(k) && !k.endsWith("Set") && !NON_SECRET_DESPITE_NAME.has(k))
    expect(leaked).toEqual([])
  })

  test("regression: previously-omitted fields are now present", async () => {
    const body = await getConfig()
    // These were silently missing from the old hand-maintained allowlist.
    for (const key of [
      "webSearchEnabled",
      "webSearchBackend",
      "thinkingSignatureCompat",
      "coerceAdaptiveThinking",
      "thinkingBlockSanitizeCheck",
      "systemDefaultMode",
      "rewriteServerTools",
      "streamKeepalivePingSec",
      "sanitizeToolNames",
    ]) {
      expect(key in body).toBe(true)
    }
  })

  test("startup-phase config fields (not hot-reloadable) are included", async () => {
    const body = await getConfig()
    for (const key of ["accountType", "ghcApiBaseUrl", "verbose", "modelOverrides", "rateLimiter"]) {
      expect(key in body).toBe(true)
    }
  })
})

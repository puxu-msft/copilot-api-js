/**
 * `GET /api/hooks` (effective state) + `POST /api/hooks/reload` (data-URL
 * reload, warn-continue) — Phase 4 of the upstream-hook-middleware feature.
 *
 * `GET /` separates DECLARED config (`state.hooksEnabled` /
 * `state.hooksUpstreamModule`, set by config.yaml) from EFFECTIVE loaded state
 * (`getUpstreamHookState()`, only changed by a successful reload) — see spec
 * §6.5 / review MEDIUM-1. `POST /reload` never throws: a malformed module keeps
 * the previously-loaded hook in place and reports the error at 200, matching
 * the project's "config warn-continue" philosophy (runtime hot-reload never
 * kills the process on a bad config/module).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import path from "node:path"

import { resetUpstreamHook } from "~/lib/pipeline/hooks/loader"
import {
  //
  restoreStateForTests,
  setHooksConfig,
  snapshotStateForTests,
  type StateSnapshot,
} from "~/lib/state"
import { hooksRoutes } from "~/routes/hooks/route"

const fixtureDir = path.join(import.meta.dir, "../pipeline/hooks/fixtures")
const validHookPath = path.join(fixtureDir, "valid-hook.ts")
const noExportsPath = path.join(fixtureDir, "no-exports.ts")

interface HooksStateBody {
  enabled: boolean
  declaredModule: string | null
  loadedModule: string | null
  loadedAt: number | null
  version: string | null
  exports: Array<string>
  lastReloadError?: string
}

interface ReloadResponseBody {
  ok: boolean
  module?: string
  exports?: Array<string>
  version?: string
  error?: string
}

describe("/api/hooks", () => {
  let snapshot: StateSnapshot

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    resetUpstreamHook()
  })

  afterEach(() => {
    restoreStateForTests(snapshot)
    resetUpstreamHook()
  })

  describe("GET /", () => {
    test("reports disabled/unloaded state when hooks are not configured", async () => {
      const res = await hooksRoutes.request("/")
      expect(res.status).toBe(200)
      const body = (await res.json()) as HooksStateBody

      expect(body).toEqual({
        enabled: false,
        declaredModule: null,
        loadedModule: null,
        loadedAt: null,
        version: null,
        exports: [],
      })
    })

    test("reflects the effective loaded state after a successful reload", async () => {
      setHooksConfig({ hooksEnabled: true, hooksUpstreamModule: validHookPath })
      const reloadRes = await hooksRoutes.request("/reload", { method: "POST" })
      expect(reloadRes.status).toBe(200)

      const res = await hooksRoutes.request("/")
      const body = (await res.json()) as HooksStateBody

      expect(body.enabled).toBe(true)
      expect(body.declaredModule).toBe(validHookPath)
      expect(body.loadedModule).toBe(validHookPath)
      expect(body.exports).toEqual(["onExchange"])
      expect(typeof body.loadedAt).toBe("number")
      expect(typeof body.version).toBe("string")
      expect(body).not.toHaveProperty("lastReloadError")
    })

    test("surfaces lastReloadError after a failed reload while the previous hook stays effective", async () => {
      setHooksConfig({ hooksEnabled: true, hooksUpstreamModule: validHookPath })
      await hooksRoutes.request("/reload", { method: "POST" })

      setHooksConfig({ hooksUpstreamModule: noExportsPath })
      const badReload = await hooksRoutes.request("/reload", { method: "POST" })
      expect(badReload.status).toBe(200)
      const badBody = (await badReload.json()) as ReloadResponseBody
      expect(badBody.ok).toBe(false)
      expect(badBody.error).toContain("exports none of")

      const res = await hooksRoutes.request("/")
      const body = (await res.json()) as HooksStateBody

      // Declared config already points at the bad module, but the EFFECTIVE
      // (loaded) hook is untouched — the old module/exports are still active.
      expect(body.declaredModule).toBe(noExportsPath)
      expect(body.loadedModule).toBe(validHookPath)
      expect(body.exports).toEqual(["onExchange"])
      expect(body.lastReloadError).toContain("exports none of")
    })
  })

  describe("POST /reload", () => {
    test("400s when hooks.upstream_module is not configured", async () => {
      const res = await hooksRoutes.request("/reload", { method: "POST" })
      expect(res.status).toBe(400)
      const body = (await res.json()) as ReloadResponseBody

      expect(body.ok).toBe(false)
      expect(body.error).toContain("not configured")
    })

    test("loads a valid hook module and returns ok:true with exports/version", async () => {
      setHooksConfig({ hooksUpstreamModule: validHookPath })
      const res = await hooksRoutes.request("/reload", { method: "POST" })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ReloadResponseBody

      expect(body.ok).toBe(true)
      expect(body.module).toBe(validHookPath)
      expect(body.exports).toEqual(["onExchange"])
      expect(typeof body.version).toBe("string")
    })

    test("returns ok:false at 200 and keeps the previous hook when the module is malformed", async () => {
      setHooksConfig({ hooksUpstreamModule: validHookPath })
      await hooksRoutes.request("/reload", { method: "POST" })

      setHooksConfig({ hooksUpstreamModule: noExportsPath })
      const res = await hooksRoutes.request("/reload", { method: "POST" })
      expect(res.status).toBe(200)
      const body = (await res.json()) as ReloadResponseBody

      expect(body.ok).toBe(false)
      expect(body.module).toBe(noExportsPath)
      expect(body.error).toContain("exports none of")
    })
  })
})

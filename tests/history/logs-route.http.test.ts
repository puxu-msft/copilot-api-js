/**
 * Regression guard for GET /api/logs — the `limit` query is CLAMPED by the
 * handler (non-numeric/absent → 100, >500 → 500), it must NOT be rejected.
 *
 * The OpenAPI conversion (commit 9148782) briefly declared a
 * `z.coerce.number().int().min(1).max(500)` query schema, which `@hono/zod-openapi`
 * auto-validates — turning `?limit=1000` / `?limit=abc` into a 400 ZodError that
 * the old plain handler had clamped to a 200. This locks the clamp behavior so a
 * future schema tightening can't silently re-break it.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { createFullTestApp } from "../helpers/test-app"

useIsolatedRuntime()

const app = createFullTestApp()

describe("GET /api/logs limit clamping", () => {
  test.each(["limit=1000", "limit=0", "limit=abc", "limit=-5", "", "limit=50"])("?%s is clamped, not rejected (200)", async (q) => {
    const res = await app.request(`/api/logs?${q}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<unknown>; total: number }
    expect(Array.isArray(body.entries)).toBe(true)
    expect(typeof body.total).toBe("number")
  })
})

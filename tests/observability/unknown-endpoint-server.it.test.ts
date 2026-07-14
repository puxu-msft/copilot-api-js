/**
 * Task 3 — unknown endpoint server integration (real createServer, all middleware).
 *
 * spec §8 核心纪律：用真实 createServer()（含 cors/trimTrailingSlash/config middleware）
 * 建影子 router，不用最小 Hono——否则重蹈 PoC 轮1「最小 app 假通过、合并态全错」。
 *
 * 注意：createServer 的 config middleware 每请求跑 applyConfigToState，会用 config.yaml
 * 覆盖 state.unknownEndpointLogging。故 level 测试经临时 config 文件驱动（PATHS 重定向），
 * 不用直接 setUnknownEndpointLogging。
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { resetApplyState, resetConfigCache, setBundledConfigForTests } from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"
import { resetConfigManagedState, restoreStateForTests, snapshotStateForTests, type StateSnapshot } from "~/lib/state"
import { createServer } from "~/server"

let originalState: StateSnapshot
let tmpDir: string
let savedAppDir: string
let savedConfigYaml: string
let warnSpy: Array<string>
let origWarn: typeof consola.warn

async function writeConfig(content: string): Promise<void> {
  await fs.writeFile(PATHS.CONFIG_YAML, content, "utf8")
  resetConfigCache()
}

beforeEach(async () => {
  originalState = snapshotStateForTests()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "uel-server-"))
  savedAppDir = PATHS.APP_DIR
  savedConfigYaml = PATHS.CONFIG_YAML
  ;(PATHS as { APP_DIR: string }).APP_DIR = tmpDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = path.join(tmpDir, "config.yaml")
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests({})
  resetConfigManagedState() // warn/warn baseline
  await writeConfig("") // empty config → retain-on-absence → warn/warn
  // Collect consola.warn (finalizer default level is warn).
  warnSpy = []
  origWarn = consola.warn
  consola.warn = ((msg: unknown) => void warnSpy.push(String(msg))) as unknown as typeof consola.warn
})

afterEach(async () => {
  consola.warn = origWarn
  restoreStateForTests(originalState)
  ;(PATHS as { APP_DIR: string }).APP_DIR = savedAppDir
  ;(PATHS as { CONFIG_YAML: string }).CONFIG_YAML = savedConfigYaml
  await fs.rm(tmpDir, { recursive: true, force: true })
  resetConfigCache()
  resetApplyState()
  setBundledConfigForTests(null)
})

describe("unknown endpoint server integration", () => {
  test("real unknown path → 404 Not Found (not misclassified 405)", async () => {
    const app = createServer()
    const res = await app.request("/__definitely_missing__")
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Not Found" })
    expect(warnSpy.some((l) => l.includes("[404] GET /__definitely_missing__"))).toBe(true)
  })

  test("wrong method on registered route → 405 + Allow + body", async () => {
    const app = createServer()
    const res = await app.request("/v1/messages", { method: "DELETE" })
    expect(res.status).toBe(405)
    expect(await res.json()).toEqual({ error: "Method Not Allowed" })
    expect(res.headers.get("allow")).toContain("POST")
  })

  test("route-owned c.notFound (missing UI asset) stays 404, no unknown log", async () => {
    const app = createServer()
    const res = await app.request("/ui/assets/does-not-exist-12345.js")
    expect(res.status).toBe(404)
    // GET /ui/assets/* 命中业务 route → route-owned → 不产生 unknown 日志
    expect(warnSpy.some((l) => l.includes("/ui/assets/does-not-exist-12345.js"))).toBe(false)
  })

  test("level=silent → no log", async () => {
    await writeConfig("unknown_endpoint_logging:\n  not_found: silent\n  method_not_allowed: silent\n")
    const app = createServer()
    await app.request("/__missing_silent__")
    expect(warnSpy).toEqual([])
  })

  test("level=warn → consola.warn called once with formatted line", async () => {
    await writeConfig("unknown_endpoint_logging:\n  not_found: warn\n  method_not_allowed: warn\n")
    const app = createServer()
    await app.request("/__missing_warn__")
    const hits = warnSpy.filter((l) => l.includes("[404] GET /__missing_warn__"))
    expect(hits.length).toBe(1)
  })

  test("OPTIONS on unknown path → 204 via CORS, not classified (documented exception)", async () => {
    const app = createServer()
    const res = await app.request("/__missing_opt__", { method: "OPTIONS" })
    expect(res.status).toBe(204)
    expect(warnSpy).toEqual([])
  })

  test("GET trailing-slash unknown path → not 404-logged (trimTrailingSlash redirects)", async () => {
    const app = createServer()
    const res = await app.request("/__missing_ts__/")
    // trimTrailingSlash 把 GET trailing-slash 404 改 301（或 Hono 版本差异下非 404）。
    // 核心不变量：finalizer 不因它记 404（避免「记 404 实返 301」）。
    expect(res.status).not.toBe(404)
    expect(warnSpy.some((l) => l.includes("/__missing_ts__"))).toBe(false)
  })

  test("browser probe favicon → 204, no log", async () => {
    const app = createServer()
    const res = await app.request("/favicon.ico")
    expect(res.status).toBe(204)
    expect(warnSpy).toEqual([])
  })

  test("cache isolation: two servers classify against their own routes", async () => {
    const a = createServer()
    const b = createServer({ externalUiUrl: "http://example.test" })
    expect((await a.request("/__iso_a__")).status).toBe(404)
    expect((await b.request("/__iso_b__")).status).toBe(404)
  })
})

import {
  //
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import consola from "consola"
import { readFileSync } from "node:fs"

import {
  //
  buildShadowRouter,
  classifyUnknownEndpoint,
  formatUnknownEndpointLine,
  logUnknownEndpoint,
} from "~/lib/observability/unknown-endpoint"

// 模拟真实 server.routes 形状（含全局中间件 ALL /* 与业务路由）。
const ROUTES = [
  { method: "ALL", path: "/*" }, // 全局中间件 catch-all（须被过滤）
  { method: "POST", path: "/v1/messages" },
  { method: "GET", path: "/v1/models" },
  { method: "GET", path: "/users/:id" },
  { method: "ALL", path: "/history" }, // 业务 .all()（也被过滤，不构成 405 candidate）
]

describe("classifyUnknownEndpoint", () => {
  const idx = buildShadowRouter(ROUTES)

  test("real routing miss → unknown-not-found 404", () => {
    expect(classifyUnknownEndpoint(idx, "GET", "/__definitely_missing__")).toEqual({ kind: "unknown-not-found", status: 404 })
  })

  test("wrong method on POST-only route → 405 allow=POST", () => {
    expect(classifyUnknownEndpoint(idx, "DELETE", "/v1/messages")).toEqual({ kind: "method-not-allowed", status: 405, allow: ["POST"] })
  })

  test("param route wrong method → 405 allow includes GET,HEAD", () => {
    const c = classifyUnknownEndpoint(idx, "PUT", "/users/42")
    expect(c.kind).toBe("method-not-allowed")
    if (c.kind === "method-not-allowed") expect(c.allow).toEqual(["GET", "HEAD"])
  })

  test("current method IS registered (route-owned c.notFound) → route-owned-not-found", () => {
    // GET /v1/models 存在；若 handler 主动 c.notFound()，当前 method 命中 → 不改 405。
    expect(classifyUnknownEndpoint(idx, "GET", "/v1/models")).toEqual({ kind: "route-owned-not-found" })
  })

  test("HEAD on GET route treated as route-owned (auto-HEAD effective method)", () => {
    expect(classifyUnknownEndpoint(idx, "HEAD", "/v1/models")).toEqual({ kind: "route-owned-not-found" })
  })

  test("HEAD on POST-only route → 405 allow=POST (no GET → no HEAD derive)", () => {
    expect(classifyUnknownEndpoint(idx, "HEAD", "/v1/messages")).toEqual({ kind: "method-not-allowed", status: 405, allow: ["POST"] })
  })
})

describe("formatUnknownEndpointLine", () => {
  test("404 line", () => {
    const line = formatUnknownEndpointLine({ classification: { kind: "unknown-not-found", status: 404 }, method: "GET", path: "/x", ua: "curl/8" })
    expect(line).toBe("[404] GET /x  ua=curl/8")
  })

  test("405 line with allow", () => {
    const line = formatUnknownEndpointLine({
      classification: { kind: "method-not-allowed", status: 405, allow: ["GET", "POST"] },
      method: "DELETE",
      path: "/y",
      ua: "-",
    })
    expect(line).toBe("[405] DELETE /y  allow=GET,POST  ua=-")
  })
})

describe("logUnknownEndpoint level dispatch", () => {
  test("silent → consola not called", () => {
    const spy = mock(() => {})
    const orig = consola.warn
    consola.warn = spy as unknown as typeof consola.warn
    logUnknownEndpoint("silent", { classification: { kind: "unknown-not-found", status: 404 }, method: "GET", path: "/x", ua: "-" })
    consola.warn = orig
    expect(spy).not.toHaveBeenCalled()
  })

  test("warn → consola.warn called with formatted line", () => {
    const spy = mock(() => {})
    const orig = consola.warn
    consola.warn = spy as unknown as typeof consola.warn
    logUnknownEndpoint("warn", { classification: { kind: "unknown-not-found", status: 404 }, method: "GET", path: "/x", ua: "-" })
    consola.warn = orig
    expect(spy).toHaveBeenCalledWith("[404] GET /x  ua=-")
  })
})

describe(".all() route-owned boundary guard (spec §4 known boundary)", () => {
  test("no .all() route handler directly calls c.notFound()", () => {
    // 三态 route-owned 识别只覆盖 method-specific route。`.all()` 业务 handler 调
    // c.notFound() 会被误判成 unknown-404/405（shadow 排除 ALL route → ① 不命中）。
    // 现有 `.all()` 均不调 c.notFound()——此守卫锁死该前提；将来新增违反者变红，
    // 逼迫先扩展 provenance（c.req.matchedRoutes/routeIndex，记 deferred-backlog）。
    // 单行精确检测（项目 .all() 均为单行 arrow）：某行同时含 `.all(` 与 `c.notFound(`。
    // 正样本：把某 .all() 改成 `.all("/", (c) => c.notFound())` → 同行命中 → 变红。
    const glob = new Bun.Glob("src/routes/**/*.ts")
    const offenders: Array<string> = []
    for (const file of glob.scanSync(".")) {
      const src = readFileSync(file, "utf8")
      for (const [i, line] of src.split("\n").entries()) {
        if (line.includes(".all(") && line.includes("c.notFound(")) offenders.push(`${file}:${i + 1}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

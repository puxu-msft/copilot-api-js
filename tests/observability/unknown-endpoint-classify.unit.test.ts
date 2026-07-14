import {
  //
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import consola from "consola"

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
    const line = formatUnknownEndpointLine({ classification: { kind: "method-not-allowed", status: 405, allow: ["GET", "POST"] }, method: "DELETE", path: "/y", ua: "-" })
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

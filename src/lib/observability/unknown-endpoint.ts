/**
 * unknown HTTP endpoint 分类 + 日志（纯逻辑 + finalizer middleware）。
 *
 * 「打到代理但没匹配任何业务路由」的请求经 Hono global notFound handler。本模块把它
 * 分成三态：route-owned-not-found（业务 handler 主动 c.notFound()，保持 404）/
 * unknown-not-found（真 routing miss，404）/ method-not-allowed（405）。
 *
 * 关键：不能直接用 `server.router.match`——全局中间件注册成 `ALL /*` catch-all，会
 * 污染匹配使任何路径都命中。改从公开 `server.routes` 过滤真实路由建独立影子 TrieRouter。
 * 详见 docs/spec/2026-07-14-unknown-endpoint-logging.md §4 + exp/unknown-endpoint-405/FINDINGS.md。
 */

import type {
  //
  Hono,
  MiddlewareHandler,
} from "hono"

import consola from "consola"
import { TrieRouter } from "hono/router/trie-router"

import type { LogLevel } from "~/lib/state"

import { state } from "~/lib/state"

export type Classification =
  | { kind: "route-owned-not-found" }
  | { kind: "unknown-not-found"; status: 404 }
  | { kind: "method-not-allowed"; status: 405; allow: Array<string> }

export interface ShadowIndex {
  shadow: TrieRouter<true>
  methods: Set<string>
}

export interface UnknownEndpointInfo {
  classification: Classification
  method: string
  path: string
  ua: string
}

/** 探测/排序顺序；HEAD 由 auto-HEAD 派生，紧随 GET。 */
const PROBE_ORDER = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]

/** HEAD dispatch 走 GET 路由（Hono auto-HEAD）；分类时用 effective method 检查。 */
function effMethod(m: string): string {
  return m === "HEAD" ? "GET" : m
}

/**
 * 从公开的 `server.routes` 构建只含真实业务路由的影子 router + candidate method 集。
 * 过滤 `method === "ALL"`（`.use()` middleware 与 `.all()` 业务路由都是 ALL；后者允许
 * 所有 method、不构成 method-not-allowed，故不参与 candidate）。
 */
export function buildShadowRouter(routes: ReadonlyArray<{ method: string; path: string }>): ShadowIndex {
  const shadow = new TrieRouter<true>()
  const methods = new Set<string>()
  const seen = new Set<string>()
  for (const r of routes) {
    if (r.method === "ALL") continue
    methods.add(r.method)
    const key = `${r.method} ${r.path}`
    if (seen.has(key)) continue // .route() 多前缀挂载会重复
    seen.add(key)
    shadow.add(r.method, r.path, true)
  }
  return { shadow, methods }
}

function matches(shadow: TrieRouter<true>, method: string, path: string): boolean {
  try {
    return shadow.match(method, path)[0].length > 0
  } catch {
    return false
  }
}

export function classifyUnknownEndpoint(index: ShadowIndex, method: string, path: string): Classification {
  const { shadow, methods } = index
  // ① 当前 method 本身命中业务 route → 业务主动 c.notFound()，保持 404、不改写、不日志。
  if (matches(shadow, effMethod(method), path)) return { kind: "route-owned-not-found" }

  // ② 当前 method 无业务 route，探测其他 candidate method。
  const allow: Array<string> = []
  for (const m of methods) {
    if (m === method) continue
    if (matches(shadow, m, path)) allow.push(m)
  }
  if (allow.length === 0) return { kind: "unknown-not-found", status: 404 }
  if (allow.includes("GET") && !allow.includes("HEAD")) allow.push("HEAD") // auto-HEAD 派生
  // 稳定排序（Allow 头 golden 稳定）：按 PROBE_ORDER，HEAD 紧随 GET。
  const ordered = [...new Set(allow)].sort((a, b) => PROBE_ORDER.indexOf(a) - PROBE_ORDER.indexOf(b))
  return { kind: "method-not-allowed", status: 405, allow: ordered }
}

export function formatUnknownEndpointLine(info: UnknownEndpointInfo): string {
  const { classification, method, path, ua } = info
  const status = classification.kind === "method-not-allowed" ? 405 : 404
  const allowPart = classification.kind === "method-not-allowed" ? `  allow=${classification.allow.join(",")}` : ""
  return `[${status}] ${method} ${path}${allowPart}  ua=${ua}`
}

export function logUnknownEndpoint(level: LogLevel, info: UnknownEndpointInfo): void {
  if (level === "silent") return
  consola[level](formatUnknownEndpointLine(info))
}

// ============================================================================
// server 接线：按实例缓存的影子 router + finalizer middleware（Task 3 消费）
// ============================================================================

// 按 server 实例缓存影子 router（非模块级单例；lazy 构建，routes 首次 request 前须注册完）。
const shadowCache = new WeakMap<Hono, ShadowIndex>()

export function getShadowIndex(server: Hono): ShadowIndex {
  let idx = shadowCache.get(server)
  if (!idx) {
    idx = buildShadowRouter(server.routes)
    shadowCache.set(server, idx)
  }
  return idx
}

/** Hono context 上暂存 unknown 分类结果的 key（finalizer 读取）。 */
export const UNKNOWN_ENDPOINT_CTX_KEY = "unknownEndpoint"

/**
 * 在 `trimTrailingSlash` 外层注册：await next() 后读最终 c.res.status，仅当仍是
 * 404/405 时按 state 级别打日志（GET/HEAD trailing-slash 被改 301 者不记，避免
 * 「记 404 实返 301」误导）。route-owned-not-found 不挂 context，故不会被记录。
 */
export function unknownEndpointFinalizer(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    const info = c.get(UNKNOWN_ENDPOINT_CTX_KEY as never) as UnknownEndpointInfo | undefined
    if (!info) return
    const status = c.res.status
    if (status !== 404 && status !== 405) return
    const level = status === 405 ? state.unknownEndpointLogging.methodNotAllowed : state.unknownEndpointLogging.notFound
    logUnknownEndpoint(level, info)
  }
}

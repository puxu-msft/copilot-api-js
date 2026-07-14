# unknown HTTP endpoint 可配置日志 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给「打到代理但没匹配任何业务路由」的 unknown HTTP endpoint 加可配置日志——按归类状态码（404 未匹配路径 / 405 路径存在但 method 不对）各配一个日志级别，并实现 405 拆分（返回真 405 + `Allow`）。

**Architecture:** 三层落地——(1) config scaffolding：新 `unknown_endpoint_logging` section + state 字段 + config→state 接线；(2) 纯分类逻辑 `unknown-endpoint.ts`：从公开 `server.routes` 派生**影子 TrieRouter**（绕开全局中间件 `ALL /*` 污染）+ **三态分类**（先判当前 method 避免把业务 `c.notFound()` 误改 405）+ 日志格式化/级别分发；(3) server.ts 接线：`notFound` 只分类+挂 context，新增 `unknownEndpointFinalizer` middleware 注册在 `trimTrailingSlash` 外层读最终 `c.res.status` 后打日志。日志经现成 consola → republish → TUI + FileSink。

**Tech Stack:** Hono 4.12.27（`server.routes` 公开 API + `hono/router/trie-router` 的 `TrieRouter`）；consola；Zod 4；`bun test`。

## Global Constraints

（每个 task 隐含包含本节，值逐字来自 spec `docs/spec/2026-07-14-unknown-endpoint-logging.md`）

- **默认值 `warn/warn`**：404 与 405 两类默认级别均为 `warn`，由 bundled `config.yaml` + `CONFIG_MANAGED_DEFAULTS` 提供，**不**在 leaf schema 用 `.default()`。
- **日志级别枚举**：`silent | debug | info | warn | error`；`silent` = 完全不调 consola；其余调 `consola[level]`，受 consola 全局 level gate 节制。
- **schema 用 `nullableEnum()`**：字段级 `null` = 删除 key（`.nullish()` 契约），**不用**裸 `z.enum()`。
- **405 wire contract**：404 → `{ "error": "Not Found" }`（body 不变）；405 → `{ "error": "Method Not Allowed" }` + `Allow: <methods>` 头。
- **影子 router 只用公开 `server.routes`**：过滤 `method === "ALL"`（`.use()` middleware 与 `.all()` 业务路由都是 ALL，允许所有 method、不参与 405 candidate）；candidate method 从 routes 派生；用 `TrieRouter`（非 RegExpRouter，后者有 build 锁）。
- **三态分类**：`route-owned-not-found`（当前 method 已命中业务 route → 是业务主动 `c.notFound()`，保持 404、不改写、不进日志）/ `unknown-not-found`（真 routing miss，404）/ `method-not-allowed`（405）。effective method：HEAD 按 GET 检查；`Allow` 含 GET 则派生 HEAD。
- **finalizer 唯一化**：`notFound` 只分类+挂 context；专用 `unknownEndpointFinalizer` middleware 注册在 `trimTrailingSlash` **外层**（紧随 `observabilityMiddleware`），`await next()` 后仅当最终 `c.res.status` ∈ {404, 405} 时打日志（GET/HEAD trailing-slash 被改 301 者不记）。**不复用** `observabilityMiddleware`。
- **缓存隔离**：影子 router 按 server 实例缓存（`WeakMap<Hono, ShadowIndex>`），**非模块级单例**。lazy 构建（首次 unknown endpoint 命中时）。
- **invariant**：所有 route 必须在首次 request 前注册；首次分类后新增 route 不重建缓存。
- **已知边界**：三态 route-owned 识别只覆盖 method-specific route；`.all()` handler 调 `c.notFound()` 会误判——但现有 `.all()` handler 均不调 `c.notFound()`（守卫测试锁死），精确识别记 backlog。
- **OPTIONS 保留现状**：全局 `cors()` 对所有 OPTIONS 返 204、不进本管线（用户裁决，明确例外）。
- **不碰 4141 主服务器**：测试用 `app.request()` 内存调用或非 4141 端口；不 `pkill`/`killall`。
- **红绿对照**：每个测试先跑红（证能抓到坏行为）再实现跑绿。

## File Structure

- `src/lib/config/schema.ts`（改）— 新增 `UnknownEndpointLoggingSchema` + `LogLevel` 枚举常量 + 挂到 `ConfigSchema`。
- `src/lib/config/config.ts`（改）— `applyConfigToState` 映射 `config.unknown_endpoint_logging` → state。
- `src/lib/state.ts`（改）— 4 处：`State` interface 字段、`CONFIG_MANAGED_DEFAULTS`、`mutableState` init、`resetConfigManagedState`；新 setter `setUnknownEndpointLogging`。
- `src/lib/observability/unknown-endpoint.ts`（建）— 纯逻辑：`LogLevel`/`Classification`/`ShadowIndex` 类型 + `buildShadowRouter` + `classifyUnknownEndpoint` + `formatUnknownEndpointLine` + `logUnknownEndpoint` + `getShadowIndex`（WeakMap 缓存）+ `unknownEndpointFinalizer` middleware。
- `src/server.ts`（改）— `notFound` 三态改造；注册 `unknownEndpointFinalizer`；清理过时 browserProbe 注释。
- `config.yaml` / `config.example.yaml` / `config.schema.json`（改）— 发布默认 + 注释示例 + 生成 schema。
- `docs/API.md` / `docs/DESIGN.md`（改）— notFound/405 行为 + 配置节。
- 测试：`tests/config/unknown-endpoint-logging-config.unit.test.ts`、`tests/observability/unknown-endpoint-classify.unit.test.ts`、`tests/observability/unknown-endpoint-server.it.test.ts`。

---

### Task 1: Config scaffolding（schema + state + config→state 接线）

**Files:**
- Modify: `src/lib/config/schema.ts`（`ConfigSchema` object 内加字段，约 :920-980 区）
- Modify: `src/lib/state.ts`（`State` interface :116 区、`CONFIG_MANAGED_DEFAULTS` :1559、`mutableState` :1850、`resetConfigManagedState` :1711、新 setter）
- Modify: `src/lib/config/config.ts`（`applyConfigToState` :587 区）
- Test: `tests/config/unknown-endpoint-logging-config.unit.test.ts`（建）

**Interfaces:**
- Produces: `LogLevel = "silent" | "debug" | "info" | "warn" | "error"`（从 `state.ts` export）；`state.unknownEndpointLogging: { notFound: LogLevel; methodNotAllowed: LogLevel }`；config key `unknown_endpoint_logging: { not_found?: LogLevel; method_not_allowed?: LogLevel }`。

- [ ] **Step 1: 写失败测试**

建 `tests/config/unknown-endpoint-logging-config.unit.test.ts`：

```ts
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { applyConfigToState, resetApplyState, resetConfigCache, setBundledConfigForTests } from "~/lib/config/config"
import { PATHS } from "~/lib/config/paths"
import { ConfigSchema } from "~/lib/config/schema"
import { resetConfigManagedState, restoreStateForTests, snapshotStateForTests, state, type StateSnapshot } from "~/lib/state"

describe("unknown_endpoint_logging config", () => {
  let snap: StateSnapshot
  const origConfigPath = PATHS.CONFIG_PATH
  const tmpFiles: Array<string> = []

  afterEach(async () => {
    restoreStateForTests(snap)
    resetApplyState()
    resetConfigCache()
    ;(PATHS as { CONFIG_PATH: string }).CONFIG_PATH = origConfigPath
    for (const f of tmpFiles.splice(0)) await fs.rm(f, { force: true })
  })

  async function writeConfig(yaml: string): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uel-cfg-"))
    const p = path.join(dir, "config.yaml")
    await fs.writeFile(p, yaml)
    tmpFiles.push(p)
    ;(PATHS as { CONFIG_PATH: string }).CONFIG_PATH = p
    resetConfigCache()
  }

  test("schema accepts valid levels", () => {
    const parsed = ConfigSchema.parse({ unknown_endpoint_logging: { not_found: "debug", method_not_allowed: "error" } })
    expect(parsed.unknown_endpoint_logging).toEqual({ not_found: "debug", method_not_allowed: "error" })
  })

  test("schema rejects invalid level (strip in graceful path)", () => {
    // strict object → unknown value should fail parse; validateConfig strips it. Here assert raw parse throws.
    expect(() => ConfigSchema.parse({ unknown_endpoint_logging: { not_found: "loud" } })).toThrow()
  })

  test("null deletes a single key (nullish contract)", () => {
    const parsed = ConfigSchema.parse({ unknown_endpoint_logging: { not_found: null, method_not_allowed: "info" } })
    expect(parsed.unknown_endpoint_logging?.not_found).toBeUndefined()
    expect(parsed.unknown_endpoint_logging?.method_not_allowed).toBe("info")
  })

  test("default is warn/warn when section absent", () => {
    snap = snapshotStateForTests()
    resetConfigManagedState()
    expect(state.unknownEndpointLogging).toEqual({ notFound: "warn", methodNotAllowed: "warn" })
  })

  test("applyConfigToState maps config → state", async () => {
    snap = snapshotStateForTests()
    setBundledConfigForTests({})
    await writeConfig("unknown_endpoint_logging:\n  not_found: silent\n  method_not_allowed: error\n")
    await applyConfigToState()
    expect(state.unknownEndpointLogging).toEqual({ notFound: "silent", methodNotAllowed: "error" })
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test tests/config/unknown-endpoint-logging-config.unit.test.ts`
Expected: FAIL —— `unknown_endpoint_logging` 不在 schema（strict 拒绝）、`state.unknownEndpointLogging` undefined。

- [ ] **Step 3: schema.ts 加 section**

在 `src/lib/config/schema.ts`，`nullableSection` 定义（:913）之后加：

```ts
export const LOG_LEVELS = ["silent", "debug", "info", "warn", "error"] as const

const UnknownEndpointLoggingSchema = z
  .object({
    not_found: nullableEnum(LOG_LEVELS),
    method_not_allowed: nullableEnum(LOG_LEVELS),
  })
  .strict()
```

在 `ConfigSchema` object 里（`negotiation_learning` 字段旁）加：

```ts
    unknown_endpoint_logging: nullableSection(UnknownEndpointLoggingSchema),
```

- [ ] **Step 4: state.ts 加字段（4 处）+ setter**

`LogLevel` 类型（`State` interface 之前）：

```ts
export type LogLevel = "silent" | "debug" | "info" | "warn" | "error"
export interface UnknownEndpointLogging {
  notFound: LogLevel
  methodNotAllowed: LogLevel
}
```

`State` interface（:116 区，任意稳定字段旁）加：`readonly unknownEndpointLogging: UnknownEndpointLogging`

`CONFIG_MANAGED_DEFAULTS`（:1559）加：

```ts
  unknownEndpointLogging: { notFound: "warn", methodNotAllowed: "warn" } as UnknownEndpointLogging,
```

`mutableState` init（:1850）加（**深拷贝**避免共享引用）：

```ts
  unknownEndpointLogging: { ...CONFIG_MANAGED_DEFAULTS.unknownEndpointLogging },
```

`resetConfigManagedState`（:1711，在某个 `set*` 调用后）加：

```ts
  setUnknownEndpointLogging({ ...CONFIG_MANAGED_DEFAULTS.unknownEndpointLogging })
```

新 setter（挨着 `setAnthropicBehavior`）：

```ts
export function setUnknownEndpointLogging(value: UnknownEndpointLogging): void {
  mutableState.unknownEndpointLogging = value
}
```

- [ ] **Step 5: config.ts 接线**

在 `src/lib/config/config.ts` 的 `applyConfigToState`（:587 区，与 anthropic 段同构），import `setUnknownEndpointLogging` 并加：

```ts
  if (config.unknown_endpoint_logging) {
    const u = config.unknown_endpoint_logging
    setUnknownEndpointLogging({
      notFound: u.not_found ?? state.unknownEndpointLogging.notFound,
      methodNotAllowed: u.method_not_allowed ?? state.unknownEndpointLogging.methodNotAllowed,
    })
  }
```

- [ ] **Step 6: 跑测试验证通过**

Run: `bun test tests/config/unknown-endpoint-logging-config.unit.test.ts`
Expected: PASS（5 个 test 全绿）。再跑 `bun run typecheck` 确认无类型错误。

- [ ] **Step 7: 提交**

```bash
git add -- src/lib/config/schema.ts src/lib/state.ts src/lib/config/config.ts tests/config/unknown-endpoint-logging-config.unit.test.ts
git commit -F- <<'EOF'
feat(config): add unknown_endpoint_logging section + state wiring

新增 `unknown_endpoint_logging.{not_found,method_not_allowed}` 配置（日志级别
silent|debug|info|warn|error，默认 warn），经 CONFIG_MANAGED_DEFAULTS + applyConfigToState
接入 state；nullableEnum 遵循 null=delete 契约。
EOF
```

---

### Task 2: 纯分类逻辑 `unknown-endpoint.ts`（影子 router + 三态分类 + 日志格式化）

**Files:**
- Create: `src/lib/observability/unknown-endpoint.ts`
- Test: `tests/observability/unknown-endpoint-classify.unit.test.ts`

**Interfaces:**
- Consumes: `LogLevel`、`state.unknownEndpointLogging`（Task 1）。
- Produces:
  - `type Classification = { kind: "route-owned-not-found" } | { kind: "unknown-not-found"; status: 404 } | { kind: "method-not-allowed"; status: 405; allow: Array<string> }`
  - `type ShadowIndex = { shadow: TrieRouter<true>; methods: Set<string> }`
  - `buildShadowRouter(routes: ReadonlyArray<{ method: string; path: string }>): ShadowIndex`
  - `classifyUnknownEndpoint(index: ShadowIndex, method: string, path: string): Classification`
  - `formatUnknownEndpointLine(info: UnknownEndpointInfo): string`
  - `type UnknownEndpointInfo = { classification: Classification; method: string; path: string; ua: string }`
  - `logUnknownEndpoint(level: LogLevel, info: UnknownEndpointInfo): void`

- [ ] **Step 1: 写失败测试**

建 `tests/observability/unknown-endpoint-classify.unit.test.ts`：

```ts
import { describe, expect, mock, test } from "bun:test"
import consola from "consola"

import { buildShadowRouter, classifyUnknownEndpoint, formatUnknownEndpointLine, logUnknownEndpoint } from "~/lib/observability/unknown-endpoint"

// 模拟真实 server.routes 形状（含全局中间件 ALL /* 与业务路由）
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
    const c = classifyUnknownEndpoint(idx, "DELETE", "/v1/messages")
    expect(c).toEqual({ kind: "method-not-allowed", status: 405, allow: ["POST"] })
  })

  test("param route wrong method → 405 allow includes GET,HEAD", () => {
    const c = classifyUnknownEndpoint(idx, "PUT", "/users/42")
    expect(c.kind).toBe("method-not-allowed")
    if (c.kind === "method-not-allowed") expect(c.allow).toEqual(["GET", "HEAD"])
  })

  test("current method IS registered (route-owned c.notFound) → route-owned-not-found", () => {
    // GET /v1/models 存在；若 handler 主动 c.notFound()，当前 method 命中 → 不改 405
    expect(classifyUnknownEndpoint(idx, "GET", "/v1/models")).toEqual({ kind: "route-owned-not-found" })
  })

  test("HEAD on GET route treated as route-owned (auto-HEAD effective method)", () => {
    expect(classifyUnknownEndpoint(idx, "HEAD", "/v1/models")).toEqual({ kind: "route-owned-not-found" })
  })

  test("HEAD on POST-only route → 405 allow=POST (no GET → no HEAD derive)", () => {
    const c = classifyUnknownEndpoint(idx, "HEAD", "/v1/messages")
    expect(c).toEqual({ kind: "method-not-allowed", status: 405, allow: ["POST"] })
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
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test tests/observability/unknown-endpoint-classify.unit.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `unknown-endpoint.ts`**

```ts
/**
 * unknown HTTP endpoint 分类 + 日志（纯逻辑）。
 *
 * 「打到代理但没匹配任何业务路由」的请求经 Hono global notFound handler。本模块
 * 把它分成三态：route-owned-not-found（业务 handler 主动 c.notFound()，保持 404）/
 * unknown-not-found（真 routing miss，404）/ method-not-allowed（405）。
 *
 * 关键：不能直接用 `server.router.match`——全局中间件注册成 `ALL /*` catch-all，会
 * 污染匹配使任何路径都命中。改从公开 `server.routes` 过滤真实路由建独立影子 TrieRouter。
 * 详见 docs/spec/2026-07-14-unknown-endpoint-logging.md §4 + exp/unknown-endpoint-405/FINDINGS.md。
 */

import consola from "consola"
import { TrieRouter } from "hono/router/trie-router"

import type { LogLevel } from "~/lib/state"

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

const PROBE_ORDER = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]

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
    return (shadow.match(method, path)?.[0] ?? []).length > 0
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
  const order = [...PROBE_ORDER, "HEAD"]
  allow.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return { kind: "method-not-allowed", status: 405, allow: [...new Set(allow)] }
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
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun test tests/observability/unknown-endpoint-classify.unit.test.ts`
Expected: PASS。若 `allow` 排序断言失败，检查 `PROBE_ORDER` 与 HEAD 派生顺序。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/observability/unknown-endpoint.ts tests/observability/unknown-endpoint-classify.unit.test.ts
git commit -F- <<'EOF'
feat(observability): unknown-endpoint 三态分类 + 影子 TrieRouter

从公开 server.routes 派生影子 TrieRouter（过滤 ALL/* 中间件污染），三态分类
（route-owned/unknown-404/405），先判当前 method 避免误改业务 c.notFound()；
auto-HEAD 派生 + 稳定 Allow 排序 + silent 级别短路。
EOF
```

---

### Task 3: server.ts 接线（notFound 三态 + finalizer middleware + 集成测试）

**Files:**
- Modify: `src/server.ts`（`notFound` :89、middleware 注册 :115 区）
- Modify: `src/lib/observability/unknown-endpoint.ts`（加 `getShadowIndex` + `unknownEndpointFinalizer`）
- Test: `tests/observability/unknown-endpoint-server.it.test.ts`（建）

**Interfaces:**
- Consumes: `buildShadowRouter`/`classifyUnknownEndpoint`/`logUnknownEndpoint`（Task 2）、`state.unknownEndpointLogging`（Task 1）。
- Produces: `getShadowIndex(server: Hono): ShadowIndex`（WeakMap 缓存）、`unknownEndpointFinalizer(): MiddlewareHandler`。

- [ ] **Step 1: 写失败测试**

建 `tests/observability/unknown-endpoint-server.it.test.ts`：

```ts
import { afterEach, describe, expect, mock, test } from "bun:test"
import consola from "consola"

import { createServer } from "~/server"
import { resetConfigManagedState, setUnknownEndpointLogging, state } from "~/lib/state"

describe("unknown endpoint server integration", () => {
  afterEach(() => resetConfigManagedState())

  test("real unknown path → 404 Not Found (not misclassified 405)", async () => {
    const app = createServer()
    const res = await app.request("/__definitely_missing__")
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Not Found" })
  })

  test("wrong method on registered route → 405 + Allow", async () => {
    const app = createServer()
    const res = await app.request("/v1/messages", { method: "DELETE" })
    expect(res.status).toBe(405)
    expect(await res.json()).toEqual({ error: "Method Not Allowed" })
    expect(res.headers.get("allow")).toContain("POST")
  })

  test("route-owned c.notFound (missing UI asset) stays 404, no unknown log", async () => {
    const spy = mock(() => {})
    const orig = consola.warn
    consola.warn = spy as unknown as typeof consola.warn
    const app = createServer()
    const res = await app.request("/ui/assets/does-not-exist.js")
    consola.warn = orig
    expect(res.status).toBe(404)
    // GET /ui/assets/* 命中业务 route → route-owned → 不产生 unknown 日志
    expect(spy).not.toHaveBeenCalled()
  })

  test("level=silent → no log; level=warn → consola.warn called once", async () => {
    const app = createServer()

    setUnknownEndpointLogging({ notFound: "silent", methodNotAllowed: "silent" })
    let spy = mock(() => {})
    let orig = consola.warn
    consola.warn = spy as unknown as typeof consola.warn
    await app.request("/__missing_silent__")
    consola.warn = orig
    expect(spy).not.toHaveBeenCalled()

    setUnknownEndpointLogging({ notFound: "warn", methodNotAllowed: "warn" })
    spy = mock(() => {})
    orig = consola.warn
    consola.warn = spy as unknown as typeof consola.warn
    await app.request("/__missing_warn__")
    consola.warn = orig
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String((spy.mock.calls[0] as Array<unknown>)[0])).toContain("[404] GET /__missing_warn__")
  })

  test("OPTIONS on unknown path → 204 via CORS, not classified (documented exception)", async () => {
    const app = createServer()
    const res = await app.request("/__missing_opt__", { method: "OPTIONS" })
    expect(res.status).toBe(204)
  })

  test("GET trailing-slash unknown path → 301 (trimTrailingSlash), finalizer does NOT log 404", async () => {
    const spy = mock(() => {})
    const orig = consola.warn
    consola.warn = spy as unknown as typeof consola.warn
    const app = createServer()
    // Hono test client 默认不跟随重定向；trimTrailingSlash 把 GET 的 trailing-slash 404 改 301。
    const res = await app.request("/__missing_ts__/")
    consola.warn = orig
    expect(res.status).toBe(301)
    // finalizer 读到最终 status=301 ∉ {404,405} → 不记日志（避免「记 404 实返 301」误导）。
    expect(spy).not.toHaveBeenCalled()
  })

  test("browser probe favicon → 204, no log", async () => {
    const spy = mock(() => {})
    const orig = consola.warn
    consola.warn = spy as unknown as typeof consola.warn
    const app = createServer()
    const res = await app.request("/favicon.ico")
    consola.warn = orig
    expect(res.status).toBe(204)
    expect(spy).not.toHaveBeenCalled()
  })

  test("cache isolation: two servers classify against their own routes", async () => {
    const a = createServer()
    const b = createServer({ externalUiUrl: "http://example.test" })
    // 两个实例各自 unknown 分类不串味（证非模块级单例）——都对未知路径判 404
    expect((await a.request("/__iso_a__")).status).toBe(404)
    expect((await b.request("/__iso_b__")).status).toBe(404)
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun test tests/observability/unknown-endpoint-server.it.test.ts`
Expected: FAIL —— DELETE /v1/messages 现返 404（未拆 405）；`setUnknownEndpointLogging` 已存在但 notFound 未接线、warn 用例无日志。

- [ ] **Step 3: 加 `getShadowIndex` + `unknownEndpointFinalizer` 到 unknown-endpoint.ts**

在 `src/lib/observability/unknown-endpoint.ts` 追加：

```ts
import type { Hono } from "hono"
import type { MiddlewareHandler } from "hono"

import { state } from "~/lib/state"

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
 * 404/405 时按 state 级别打日志（GET/HEAD trailing-slash 被改 301 者不记）。
 */
export function unknownEndpointFinalizer(): MiddlewareHandler {
  return async (c, next) => {
    await next()
    const info = c.get(UNKNOWN_ENDPOINT_CTX_KEY) as UnknownEndpointInfo | undefined
    if (!info) return
    const status = c.res.status
    if (status !== 404 && status !== 405) return
    const level = status === 405 ? state.unknownEndpointLogging.methodNotAllowed : state.unknownEndpointLogging.notFound
    logUnknownEndpoint(level, info)
  }
}
```

- [ ] **Step 4: 改 server.ts 的 notFound + 注册 finalizer**

`src/server.ts` import：

```ts
import { classifyUnknownEndpoint, getShadowIndex, UNKNOWN_ENDPOINT_CTX_KEY, unknownEndpointFinalizer } from "./lib/observability/unknown-endpoint"
```

替换 `server.notFound(...)`（:89）为三态版（保留 browserProbe，删过时注释）：

```ts
  // 浏览器自动探针（favicon / devtools）静默 204，不进 unknown-endpoint 管线（用户裁决）。
  const browserProbePaths = new Set(["/favicon.ico", "/.well-known/appspecific/com.chrome.devtools.json"])

  server.notFound((c) => {
    if (browserProbePaths.has(c.req.path)) return c.body(null, 204)
    const cls = classifyUnknownEndpoint(getShadowIndex(server), c.req.method, c.req.path)
    if (cls.kind === "method-not-allowed") {
      c.set(UNKNOWN_ENDPOINT_CTX_KEY, { classification: cls, method: c.req.method, path: c.req.path, ua: c.req.header("user-agent") ?? "-" })
      return c.json({ error: "Method Not Allowed" }, 405, { Allow: cls.allow.join(", ") })
    }
    if (cls.kind === "unknown-not-found") {
      c.set(UNKNOWN_ENDPOINT_CTX_KEY, { classification: cls, method: c.req.method, path: c.req.path, ua: c.req.header("user-agent") ?? "-" })
    }
    // route-owned-not-found: 不挂 context、不日志。
    return c.json({ error: "Not Found" }, 404)
  })
```

注册 finalizer 在 `trimTrailingSlash` 外层——紧随 `observabilityMiddleware`（:115）：

```ts
  server.use(observabilityMiddleware())
  server.use(unknownEndpointFinalizer())
  server.use(cors())
  server.use(trimTrailingSlash())
```

> 若 `c.set(UNKNOWN_ENDPOINT_CTX_KEY, …)` 报类型错，与现有 `requestContext` 一样用 cast：`c.set(UNKNOWN_ENDPOINT_CTX_KEY as never, value as never)`，读侧已 cast。

- [ ] **Step 5: 跑测试验证通过**

Run: `bun test tests/observability/unknown-endpoint-server.it.test.ts`
Expected: PASS（6 个 test）。再 `bun run typecheck`。

- [ ] **Step 6: 全量回归（防接线破坏既有路由）**

Run: `bun test tests/` （或 `bun test`）
Expected: 无新增失败。重点确认既有路由测试（models/messages http.test）仍绿——405 拆分不应影响正常请求。

- [ ] **Step 7: 提交**

```bash
git add -- src/server.ts src/lib/observability/unknown-endpoint.ts tests/observability/unknown-endpoint-server.it.test.ts
git commit -F- <<'EOF'
feat(server): unknown endpoint 405 拆分 + finalizer 日志接线

notFound 三态分类（405+Allow / 404 / route-owned 保持 404）；新增
unknownEndpointFinalizer middleware 注册在 trimTrailingSlash 外层，读最终
c.res.status 后按 state 级别打日志（trailing-slash 301 不误记）；影子 router
按 server 实例 WeakMap 缓存；清理过时 browserProbe 注释。
EOF
```

---

### Task 4: config 表面 + 文档 + `.all()` 守卫测试

**Files:**
- Modify: `config.yaml`、`config.example.yaml`
- Regenerate: `config.schema.json`
- Modify: `docs/API.md`、`docs/DESIGN.md`
- Test: `tests/observability/unknown-endpoint-classify.unit.test.ts`（追加 `.all()` 守卫）

- [ ] **Step 1: 加 `.all()` route-owned 边界守卫测试**

在 `tests/observability/unknown-endpoint-classify.unit.test.ts` 追加（锁死「现有 `.all()` handler 不调 `c.notFound()`」这一前提）：

```ts
import { readFileSync } from "node:fs"
import { globSync } from "node:fs"

describe(".all() route-owned boundary guard", () => {
  test("no existing .all() handler calls c.notFound() (spec §4 known boundary)", () => {
    // 三态识别只覆盖 method-specific route；.all() handler 调 c.notFound() 会误判。
    // 现有 .all() 均不调 c.notFound()——若将来新增违反者，此测试变红逼迫先扩展 provenance。
    const files = globSync("src/routes/**/*.ts")
    const offenders: Array<string> = []
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      // 粗粒度：文件同时含 .all( 和 c.notFound( 即需人工核查（本项目现状：0）。
      if (/\.all\(/.test(src) && /c\.notFound\(/.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })
})
```

Run: `bun test tests/observability/unknown-endpoint-classify.unit.test.ts`
Expected: PASS（现有 `.all()` 与 `c.notFound()` 不在同文件）。

> 注：`ui/route.ts` 含 `c.notFound()` 但其 `.all()` 是 external-UI proxy 分支、且 `c.notFound()` 在 `.get()` handler 内——粗粒度同文件检测会误报。改为精确断言：该文件的 `.all()` handler body 不含 `c.notFound()`。若粗检测在 `ui/route.ts` 误报，收窄为显式白名单 `ui/route.ts` 并注释说明（其 `.all()` 是 proxy、不调 notFound），或用 AST。实现者择一，保证守卫真实有效（正样本：临时给某 `.all()` 加 `c.notFound()` 应变红）。

- [ ] **Step 2: config.yaml 加发布默认**

在 `config.yaml` 合适位置加：

```yaml
unknown_endpoint_logging:
  not_found: warn
  method_not_allowed: warn
```

- [ ] **Step 3: config.example.yaml 加注释示例**

```yaml
# 未知 HTTP 端点日志：打到代理但没匹配任何业务路由的请求（客户端打错 path / 用错 method）。
# 每类配一个日志级别 silent|debug|info|warn|error（silent=不打）。默认 warn。
unknown_endpoint_logging:
  not_found: warn          # 404：真正未匹配的路径
  method_not_allowed: warn # 405：路径存在但 HTTP method 不对（返回 405 + Allow 头）
```

- [ ] **Step 4: 重新生成 config.schema.json**

Run: `bun run generate:config-schema`
Expected: `config.schema.json` diff 含新 `unknown_endpoint_logging` 定义。**勿手改**。

- [ ] **Step 5: 更新 docs/API.md + docs/DESIGN.md**

`docs/API.md`：在基础设施/错误响应节记 notFound 行为——404 `{ "error": "Not Found" }`；405 `{ "error": "Method Not Allowed" }` + `Allow` 头（路径存在但 method 不对）；unknown endpoint 日志受 `unknown_endpoint_logging` 配置控制。
`docs/DESIGN.md`：若「活的架构现状」表涉及 observability，加一行 unknown-endpoint 分类/finalizer。

- [ ] **Step 6: 跑相关测试 + typecheck + lint**

Run: `bun test tests/observability/ tests/config/unknown-endpoint-logging-config.unit.test.ts && bun run typecheck && bunx eslint src/lib/observability/unknown-endpoint.ts src/server.ts`
Expected: 全绿。

- [ ] **Step 7: 提交**

```bash
git add -- config.yaml config.example.yaml config.schema.json docs/API.md docs/DESIGN.md tests/observability/unknown-endpoint-classify.unit.test.ts
git commit -F- <<'EOF'
docs(config): unknown_endpoint_logging 配置表面 + 文档 + .all() 守卫

config.yaml/example 默认 warn/warn；重生成 config.schema.json；API.md/DESIGN.md
记 404/405 行为；加 .all()+c.notFound() 同文件守卫测试锁死 route-owned 边界前提。
EOF
```

---

## Self-Review（对照 spec）

- **Spec §3 配置形状** → Task 1（schema `nullableEnum` + null 删除测试）✓
- **Spec §4 三态分类 + 影子 router + ALL 过滤 + auto-HEAD + candidate-derived + 缓存隔离 + invariant** → Task 2（分类纯逻辑）+ Task 3（`getShadowIndex` WeakMap）✓
- **Spec §5 finalizer 唯一化 + 级别语义 + wire contract + 日志格式** → Task 2（format/dispatch）+ Task 3（finalizer 注册在 trim 外层、notFound 只挂 context）✓
- **Spec §6 config→state** → Task 1（applyConfigToState + reset）✓
- **Spec §7 涉及文件** → Task 1-4 全覆盖（含 config.yaml/example/schema.json、API/DESIGN、backlog 已在 spec 提交时落）✓
- **Spec §8 测试矩阵**：404/405 基础 ✓（T3）、route-owned 回归 ✓（T3）、param ✓（T2）、auto-HEAD ✓（T2）、OPTIONS 例外 ✓（T3）、trailing-slash 301 不记日志 ✓（T3）、`.all()` 守卫 ✓（T4）、缓存隔离 ✓（T3）、级别分发 ✓（T2/T3）、wire contract ✓（T3）、默认/校验/热重载/null 删除 ✓（T1）、探针不变（favicon 204 无日志）✓（T3）
- **Step 1 note**：Task 3 的 trailing-slash 断言依赖「Hono `app.request()` 默认不跟随 301」——若实测 `app.request` 对 GET trailing-slash 的 status 非 301（Hono 版本差异），改断言 `res.status !== 404` 且 finalizer 未记日志（核心不变量是「不误记 404」，非 301 字面）。

**Placeholder 扫描**：无 TBD/TODO；所有 code step 含完整代码。
**类型一致性**：`LogLevel`（state.ts export，Task 1）→ Task 2/3 import 一致；`Classification`/`ShadowIndex`/`UnknownEndpointInfo` 在 Task 2 定义、Task 3 复用；`setUnknownEndpointLogging`/`state.unknownEndpointLogging` Task 1 定义、Task 3 消费——一致。

# Spec：unknown HTTP endpoint 按状态码分类的可配置日志

- 状态：草案（待用户审 → 转 plan）
- 日期：2026-07-14
- 相关：[docs/API.md](../API.md)（notFound / 405 行为、配置节）、[src/server.ts](../../src/server.ts)（notFound / onError）、[src/lib/observability/republish.ts](../../src/lib/observability/republish.ts)（consola → system.log → TUI + FileSink 链路）
- 讨论：需求经四轮澄清定型（覆盖范围=按 HTTP 状态码分类、拆分 405、每状态码→日志级别、默认 warn）；405 检测机制经**三轮** Hono PoC 亲手实测定型（见 [exp/unknown-endpoint-405/FINDINGS.md](../../exp/unknown-endpoint-405/FINDINGS.md)）：轮1 裸 Hono 直接用 `router.match` 假通过 → 轮2 加真实全局中间件后**证伪**（`ALL /*` catch-all 污染 `server.router`，任何路径都误判 405）→ 轮3 **影子 TrieRouter** 方案（源自公开 `server.routes` 的真实路由）全部正确。这是「PoC harness 须复制生产接线」的又一实例。

## 1. 问题（Why）

打到本代理但**没有匹配到任何业务路由**的请求（unknown HTTP endpoint），当前对可观测性完全不可见：

- `notFound` handler（[src/server.ts:89](../../src/server.ts#L89)）直接返回 404 JSON，**不创建 RequestContext**，因此不触发 `request.*` 事件，不进 TUI 访问日志、不进 History、不进 telemetry。
- 唯一的两类特殊处理：浏览器自动探针（favicon / devtools）静默返回 204；其余未知路径返回 404 JSON。两者都不打日志。
- `onError`（[src/server.ts:72](../../src/server.ts#L72)）只覆盖**已注册路由 handler 抛出的异常**（已 `consola.error`），不覆盖 unknown endpoint。

后果：客户端配置错误（打错 path、用错 base URL、method 用错）在服务端**无任何痕迹**，排查只能靠客户端侧或抓包。[src/server.ts:85-87](../../src/server.ts#L85) 那句「return 204 silently to avoid `[FAIL]` 404 noise in TUI logs」是**过时注释**——它来自已被移除的旧 `lib/tui/middleware.ts`（那个中间件曾对每个 HTTP 请求打日志），如今 unknown endpoint 根本不进任何日志，该注释理由已不成立，本轮顺手清理。

此外，当前 Hono 架构下「已注册路径 + 错误 HTTP method」也一律返回 **404**，客户端无法区分「端点不存在」与「方法用错了」——这是 REST 语义上的一个正确性缺口。

## 2. 目标与非目标（Scope）

**目标**：

- 新增顶层配置 section `unknown_endpoint_logging`，按 unknown-endpoint 的**归类状态码**分别控制日志级别。
- 分两类：`not_found`（404，真正未匹配路径）/ `method_not_allowed`（405，路径存在但 method 不对）。
- 每类配一个日志级别 `silent | debug | info | warn | error`，`silent` = 完全不打，默认两类均为 `warn`。
- 实现 405 拆分：把「路径存在但 method 不对」从 404 里区分出来，返回**正确的 405 + `Allow` 响应头 + `{ "error": "Method Not Allowed" }` body**（REST 正确性提升，非仅日志分类）。
- 日志经现成的 consola → republish 链路自动进 **TUI + FileSink**，受 consola 全局 level gate 节制（标准日志语义）。
- 日志内容按 richest-data-flow 尽量完整（归类状态码、method、path、405 的 allowed methods、User-Agent），单行文本。
- 复用现有 config 校验 / 热重载 + config SSOT 表面（`CONFIG_MANAGED_DEFAULTS` / `resetConfigManagedState` / bundled `config.yaml` / `config.example.yaml` / 生成的 `config.schema.json`）。**注意**：`PUT /api/config/yaml` 写盘路径 `mergeConfigIntoDocument`（[src/routes/config/route.ts](../../src/routes/config/route.ts)）是**显式逐 section 列举**、**非**通用遍历——新 section 必须显式接线一行（`setNestedScalarContainer`），否则 PUT 校验通过但静默不写盘（合并态审查逮到的 Blocker，已修 + 回归测试）。

**非目标（本轮不做，已落 backlog）**：

- **不把浏览器探针（favicon / devtools）纳入本管线**：保持静默 204。backlog：将来可加第三个 key `browser_probe`（需求触发时启用），本轮不动 → 记 [docs/todo/deferred-backlog.md](../todo/deferred-backlog.md)。
- **不纳入已注册路由 handler 抛出的 error**：那属 `onError` 域（已 `consola.error` 覆盖，非当前缺陷），与「unknown endpoint」是不同关注点。backlog：若未来要求按 route family / status 配级别，应**独立设计**、不复用本 section → 记 [docs/todo/deferred-backlog.md](../todo/deferred-backlog.md)。
- **全局 CORS 对所有 OPTIONS 返回 204**（`cors()` 在 notFound 之前拦截，不要求 `Origin`/preflight header）：因此 unknown OPTIONS 请求**根本不到 notFound**、不进 404/405 分类。**用户已裁决保留现状**（不收窄 CORS）：这是本轮明确例外/非目标，写进验收测试断言其行为（见 §8）。代价「任意路径 OPTIONS 永远伪成功」是可接受的诊断盲区。
- **不改 404 的响应 body 形状**（仍是 `{ "error": "Not Found" }` JSON）；405 用 `{ "error": "Method Not Allowed" }` + `Allow` 头（wire contract 见 §5）。
- **日志不含 query string**：避免噪音 / 潜在敏感值入日志（本项目 internal-tool 姿态下泄露风险可接受，但 query 对「unknown endpoint 诊断」价值低、噪音高，故默认不含；若用户后续要可加）。

## 3. 配置形状（What）

顶层新增 section：

```yaml
unknown_endpoint_logging:
  not_found: warn          # 404：真正未匹配的路径。silent|debug|info|warn|error
  method_not_allowed: warn # 405：路径存在但 HTTP method 不对
```

- Schema（[src/lib/config/schema.ts](../../src/lib/config/schema.ts)）：`nullableSection` 包一个 `.strict()` object，两字段均用**现有 `nullableEnum(["silent","debug","info","warn","error"])`** helper（[schema.ts:80-87](../../src/lib/config/schema.ts#L80)）——**不用**裸 `z.enum().default()`。理由（reviewer 二轮 Medium）：项目 schema 契约规定所有 scalar leaf 经 `.nullish()` 接受 `null`，供 `PUT /api/config/yaml` 用 `null` 删除单个 key（post-parse transform `null → undefined`）。裸 `z.enum` 不接受 null，会破坏字段级删除契约。
- **默认值不放 leaf schema**：`warn/warn` 默认由 bundled `config.yaml` + `CONFIG_MANAGED_DEFAULTS` 提供（避免在 leaf 再设第三套默认与 nullable transform 打架）。语义：section 缺失 → state/bundled 给 warn/warn；单字段缺失或被 `null` 删除 → 该字段回 warn（bundled merge 补），另一字段保留其有效值。
- 类型经 [src/lib/config/config.ts](../../src/lib/config/config.ts) 自动 re-export（SSOT-types）。
- 校验：非法值走现有 `validateConfig` 的 warn-once + strip + 用默认（graceful degradation）；`PUT /api/config/yaml` 走 `validateConfigInput` 的 structured 400（无改动）。

日志级别枚举命名对齐 consola 的方法名（`debug` / `info` / `warn` / `error`），`silent` 为本项目扩展态（不调 consola）。

## 4. 405 检测机制（How，三轮 PoC 定型）

**不能直接用 `(server as any).router.match`**：项目在 `createServer` 里注册了全局中间件（`observabilityMiddleware` / `cors` / `trimTrailingSlash` / config-hot-reload），Hono 把它们注册成 `ALL /*` catch-all 路由。PoC 轮2 实测：这使 `router.match(anyMethod, anyPath)` 对**任何**路径都返回 ≥1 handler（中间件也计入），连不存在的路径都被误判成 405——方案在生产结构下完全失效。

**正确方案：影子 TrieRouter + route-derived candidate methods + 三态分类**。从 Hono **公开的** `server.routes`（`RouterRoute[]`）过滤出真实业务路由，去重后 `add` 进一个独立的 `TrieRouter`；candidate method 集也**从 `server.routes` 派生**（而非硬编码固定表）。分类器**必须接收当前请求 method**，先判断当前请求是否已匹配业务路由（区分「真正 routing miss」与「已匹配 route 的 handler 主动 `c.notFound()`」）：

```
buildShadowRouter(server):
  shadow = new TrieRouter()
  methods = Set()          // route-derived candidate methods
  seen = Set()
  for r in server.routes:
    if r.method === "ALL": continue          // ALL route（.use() middleware 或 .all() 业务路由）
                                             // 允许所有 method → 不参与 405 candidate（见下）
    methods.add(r.method)
    key = `${r.method} ${r.path}`
    if seen.has(key): continue               // .route() 多前缀挂载会重复
    seen.add(key); shadow.add(r.method, r.path, true)
  return { shadow, methods }

// effective method：HEAD 按 GET 检查（Hono auto-HEAD dispatch）
effMethod(m) = (m === "HEAD") ? "GET" : m

classifyUnknownEndpoint(shadow, methods, method, path):
  // ① 当前 method 本身命中业务 route → 这是 route-owned c.notFound()，不是 unknown endpoint
  if shadow.match(effMethod(method), path) 命中:
    return { kind: "route-owned-not-found" }   // 保持 handler 的 404，不改写、不进日志

  // ② 当前 method 没有业务 route，但其他 method 有 → 405
  allow = []
  for m in methods:
    if m === method: continue                  // 当前 method 已确认不命中（①）
    if shadow.match(m, path) 命中: allow.push(m)
  if allow.length === 0:
    return { kind: "unknown-not-found", status: 404 }   // 真正 routing miss
  if allow.includes("GET") and not allow.includes("HEAD"): allow.push("HEAD")  // auto-HEAD 派生
  sort+dedup(allow)
  return { kind: "method-not-allowed", status: 405, allow }
```

三态返回（`route-owned-not-found` / `unknown-not-found` / `method-not-allowed`）——**关键正确性边界**（reviewer 二轮 High）：设计时项目里业务 handler 会显式调 `c.notFound()`（`src/routes/ui/route.ts:160,166,170,182`，均在 `uiRoutes.get(...)` 内文件缺失时），此时当前 method 已匹配 GET route。**该原始证据文件已随 UI 外置移除**（2026-07-22，主服务器不再服务任何 UI，见 DESIGN.md「前端子项目」）——route-owned-not-found 分支的回归覆盖现由 `tests/observability/unknown-endpoint-server.it.test.ts` 里一个临时挂载的 `app.get("/__test_route_owned__", c=>c.notFound())` 样本承担，见 git 历史查原始证据。若不先判当前 method，会把业务主动选择的 404 误改成 405。`route-owned-not-found` 既不改写状态、也不进 unknown-endpoint 日志（不符合「没有匹配到任何业务路由」的定义）。

- 用 **TrieRouter**（`hono/router/trie-router`）而非 RegExpRouter：后者有 matcher-already-built 锁，动态 `add` 会抛；TrieRouter 无此限制、且支持 param/wildcard/optional 展开。
- 只依赖 Hono **公开 API** `server.routes`（`.d.ts` 里公开声明的 `RouterRoute[]`）。不能直接用 `server.router` 做 match——全局中间件 `ALL /*` 污染（PoC 轮2 证），故从 `server.routes` 派生影子 router 是**正确性**要求。
- 子应用 `.route()` 挂载的路由**已展平**进 `server.routes`（PoC 轮3 + reviewer 双确认），method 信息完整。
- **`ALL` route 的处理**（reviewer 二轮 Medium）：Hono 用同一个 `"ALL"` 同时表示 `.use()` middleware 与 `.all()` 业务路由（项目有真实 `.all()`：[src/routes/history/route.ts:29](../../src/routes/history/route.ts#L29)），**仅凭 method 无法区分二者**。过滤 `ALL` 的正确理由是「ALL route 语义上允许所有 method、不构成 method-not-allowed」，**不是**「ALL 必是 middleware」。一个 `.all(path)` 业务路由接受该 path 的所有 method，正常请求由它接管、不到 notFound——过滤它对 405 检测无损。
- **已知边界（reviewer 三轮 Medium，方案1）**：三态 route-owned 识别（①）**只覆盖 method-specific route**。若某 `.all()` 业务 handler **主动调 `c.notFound()`**，请求会进 global notFound（`c.notFound()` 直接执行 global notFound handler），但 shadow 已排除所有 ALL route，故①识别不到该 path 已被 `.all()` 接管 → 会误判成 `unknown-not-found`（或若同 path 有其他 method-specific route，误判 405）。**经核实项目现有 `.all()` handler 均不调 `c.notFound()`**（history 返回 `c.json(…404)` 非 `c.notFound()`；UI 外置前 ui 是 proxy，同样不调），故**当前无实际漏判**。处置：§8 加守卫测试锁死「现有 `.all()` handler 不调 `c.notFound()`」；「ALL route-owned notFound 精确识别」（需 `c.req.matchedRoutes`/`routeIndex` 执行时 provenance，先做小 PoC 实测 routing-miss 时的 `routeIndex`）记 backlog——未来出现该模式前必须先扩展 provenance、不得静默归 unknown。
- **candidate method 从 routes 派生**：自动覆盖将来经 `.on("TRACE"/"PURGE"/…)` 注册的非标准 method。
- **auto-HEAD 建模**（reviewer 一轮 Medium）：`Allow` 含 GET 则派生 HEAD；HEAD 不作独立匹配真相源（Hono 把 HEAD dispatch 为 GET）。
- **构建时机 + 缓存隔离**（reviewer 二轮 Medium）：`server.routes` 在所有路由注册后才完整（`notFound` 在 `registerHttpRoutes` 之前注册，[src/server.ts:89](../../src/server.ts#L89) vs :129；WS 路由更在 `createServer` 返回后才 `registerWsRoutes`，[src/start.ts:508](../../src/start.ts#L508)）。故影子 router **lazy 构建**（首次 unknown endpoint 命中时），且**按 server 实例隔离缓存**（闭包在 `createServer` 内，或 `WeakMap<Hono, ShadowIndex>`）——**不可模块级单例**（测试频繁创建多个 server 实例，会串味）。lazy 触发点在 WS 注册之后，snapshot 完整。
- **invariant（reviewer 三轮 Low）**：生产与测试**必须在首次 request 前完成所有 route 注册**；首次分类（snapshot 冻结）后新增 route 不受支持（缓存不重建）。测试里的自定义 `.on("TRACE")`/挂载 route 必须在第一次 request 前注册。若未来要支持动态注册，再按 `server.routes.length` 变化重建。
- **trailing-slash 一致性见 §5**（唯一化为 after-next finalizer）。

## 5. 记录时机（finalizer 架构）与日志级别语义

**为什么需要 finalizer**（reviewer 二轮 Medium，方案唯一化）：`trimTrailingSlash()` 在 `notFound` 返回 404 **之后**（其 `await next()` 返回时）把 GET/HEAD 的 trailing-slash 404 改写成 301。因此 `notFound` **内部无法**观察最终 forwarded status，任何「在 notFound 内预判 trim 行为」的做法都是复制 Hono middleware 规则、会随其配置漂移——**不采纳**。唯一方案：

1. **`notFound` handler** 只负责：跑 `classifyUnknownEndpoint` → 构造响应（404 body / 405 body+`Allow`）→ 把 `{ classification, method, path, ua }` 挂到 Hono context（`c.set(...)`）。**不在此打日志**。（`route-owned-not-found` 态：`notFound` 直接返回 handler 期望的 404、不挂 context。）
2. **新增专用 finalizer middleware** `unknownEndpointFinalizer`，注册在 **`trimTrailingSlash` 外层**（更早注册 → 其 `await next()` 在 trim 改写之后返回，能读到最终 `c.res.status`）：`await next()` → 读 context 上的 classification + 最终 `c.res.status` → **仅当最终 status 仍是 404/405 且与 classification 一致时**读 state 级别打日志。GET/HEAD trailing-slash 被改成 301 者 → 最终 status≠404/405 → 不打日志。
   - 注册位置：紧随 `observabilityMiddleware` 之后（二者都在 trim 外层）。**不复用** `observabilityMiddleware`——它的职责是 RequestContext 生命周期，unknown endpoint 不创建 RequestContext，混入会污染其语义。
   - 级别在 **finalizer 读取当前 state**（非 notFound 阶段冻结）：同一请求内 config 不会再变，两处读值一致；测试钉死「一次请求只产生一次 unknown 日志」。

**级别分发**（纯逻辑在新建 `src/lib/observability/unknown-endpoint.ts`）：

- `silent` → 不调 consola，直接返回（**零日志发布开销；但仍执行 405 分类**——分类是响应正确性的一部分，见 O1）。
- `debug|info|warn|error` → 调对应 `consola[level](line)`。consola 全局 level gate 决定是否真正 fan-out（例如全局 level=info 时 `debug` 被吞——标准语义，与其它模块一致；默认 `warn` 高于 info，不会被吞）。
- 经 [republish.ts](../../src/lib/observability/republish.ts) 转 `system.log` 事件 → ConsoleSink（stdout / TUI footer-coordinated）+ FileSink（`copilot-api.log`）。

**响应 wire contract**（reviewer Medium-3）：

| 状态 | body | 头 |
|---|---|---|
| 404 | `{ "error": "Not Found" }` | — |
| 405 | `{ "error": "Method Not Allowed" }` | `Allow: <methods>` |

两类均做完整 HTTP golden（断 status + body + header），不只断 status/header。

**日志行格式**（单行，纯函数生成便于测试）：

```
[404] GET /v1/mesages  ua=claude-cli/1.2.3
[405] DELETE /v1/messages  allow=GET,POST  ua=curl/8.4
```

- 字段：`[<归类状态码>] <method> <path>`，405 追加 `allow=<methods>`，末尾 `ua=<User-Agent 或 "-">`。
- User-Agent 从 `c.req.header("user-agent")` 取，缺省 `-`。
- 不含 query string、不含 body、不含 remote addr（本轮范围）。

## 6. config → state 接线

沿用现有模式（[src/lib/config/config.ts](../../src/lib/config/config.ts) `applyConfigToState` + [src/lib/state.ts](../../src/lib/state.ts) setter）：

- state 新增字段（mutable defaults + `CONFIG_MANAGED_DEFAULTS`）：`unknownEndpointLogging: { notFound: LogLevel; methodNotAllowed: LogLevel }`，默认 `{ notFound: "warn", methodNotAllowed: "warn" }`。
- `applyConfigToState`：`if (config.unknown_endpoint_logging) { ... }` 映射到 state（scalar override-only，与现有 anthropic 段同构）；`resetConfigManagedState()` 从 `CONFIG_MANAGED_DEFAULTS` 恢复。
- `unknownEndpointFinalizer` middleware 读 `state.unknownEndpointLogging`（每请求经 `applyConfigToState` 已热重载）决定级别；`notFound` 只做分类 + 挂 context（见 §5）。

## 7. 涉及文件

| 文件 | 改动 |
|---|---|
| [src/lib/config/schema.ts](../../src/lib/config/schema.ts) | 新增 `unknown_endpoint_logging` section + `LogLevel` 枚举 |
| [src/lib/config/config.ts](../../src/lib/config/config.ts) | `applyConfigToState` 映射；类型 re-export |
| [src/routes/config/route.ts](../../src/routes/config/route.ts) | `mergeConfigIntoDocument` 接线 `unknown_endpoint_logging`（PUT 写盘生效；合并态审查 Blocker 修复） |
| [src/lib/state.ts](../../src/lib/state.ts) | 新 state 字段 + setter；**加入 `CONFIG_MANAGED_DEFAULTS`**（初始化 + `resetConfigManagedState()` SSOT）+ mutable init |
| `src/lib/observability/unknown-endpoint.ts`（新建） | `buildShadowRouter(server.routes)` + `classifyUnknownEndpoint`（三态、接收当前 method）+ 日志行格式化 + 级别分发（纯逻辑，独立可测；影子 router 按 server 实例缓存——闭包或 `WeakMap`，非模块级单例） |
| [src/server.ts](../../src/server.ts) | `notFound` 改造：lazy 建/取影子 router → 三态分类 → route-owned 保持 404 / 404 / 405+Allow+body → 挂 classification 到 context；新增 `unknownEndpointFinalizer` middleware 注册在 `trimTrailingSlash` **外层**（紧随 `observabilityMiddleware`）：读最终 status + state 级别打日志；清理过时的 browserProbe 注释 |
| `config.yaml`（bundled defaults） | 发布默认 `not_found: warn` / `method_not_allowed: warn` |
| `config.example.yaml` | 完整注释示例 section |
| `config.schema.json` | 经 `bun run generate:config-schema` 重新生成（勿手改） |
| [docs/API.md](../API.md) | notFound / 405 行为 + 配置节 |
| [docs/DESIGN.md](../DESIGN.md) | 若「活的架构现状」涉及则同步 |
| [docs/todo/deferred-backlog.md](../todo/deferred-backlog.md) | 落四条 backlog：`browser_probe` 扩展、已注册路由 error 分类（独立设计）、O2(b) CORS 收窄使普通 OPTIONS 可诊断、ALL route-owned `c.notFound()` 精确识别（需 `c.req.matchedRoutes`/`routeIndex` provenance）（见 §2/§4/§9） |

## 8. 测试（TDD）

**核心纪律**：分类测试用**真实 `createServer()`**（含全部全局中间件）建影子 router，不用最小 Hono——否则重蹈 PoC 轮1「最小 app 假通过、合并态全错」。至少覆盖以下真实合并态矩阵：

- **404 vs 405 基础**：`GET /__definitely_missing__` → 404（正样本反例，证不被中间件误判 405）；`GET /v1/messages`（POST-only）→ 405 `Allow: POST`。
- **route-owned `c.notFound()`**（二轮 High 回归）：请求命中真实 GET route 但 handler 主动 `c.notFound()`——设计时的原始样本是 UI 静态资源缺失路径（`GET /ui/assets/<missing>`），**该样本已随 UI 外置移除**（2026-07-22）；现用测试内临时挂载的 `GET /__test_route_owned__` route（`app.get(...,c=>c.notFound())`）覆盖同一分支 → 最终仍是 handler 期望的 404、**不改 405**、**不产生 unknown-endpoint 日志**。
- **param 路由**：`PUT /users/:id` 类 method-miss → 405 + 正确 `Allow`。
- **auto-HEAD**：POST-only 路由上 HEAD → 405 `Allow: POST`（不派生 HEAD）；GET 路由错误 method → `Allow` 含 `GET, HEAD`；GET 路由的 HEAD 请求**由 GET route 处理、不进 global notFound、不产生 unknown 日志**（断言不是 404/405 且无 unknown log，不假定必 2xx——如 readiness HEAD 可能 503）。
- **OPTIONS / CORS**（O2 已定保留现状）：`OPTIONS /__missing__` 与 `OPTIONS /v1/messages` 均被全局 `cors()` 返 204、**不进本管线、不打日志**（断言这个明确例外）。
- **trailing-slash 矩阵**：`GET /__missing__/` / `HEAD /__missing__/`（→ 301，finalizer 因最终 status≠404/405 而不记日志）、`POST /v1/messages/`（→ 404，正常记录）——断 status + 日志条数 + 日志状态码。
- **`.all()` 业务路由**（二轮 Medium）：存在 `.all(path)` 业务路由（[src/routes/history/route.ts:29](../../src/routes/history/route.ts#L29)）时，该 path 上任意 method 都被其接管、不到 notFound、不被误判 405；`.on("TRACE", …)` 自定义 method 能被 route-derived candidate 覆盖、不静默漏。（**不**测「业务路由 method 均非 ALL」——项目本就有合法 `.all()`，该断言是错的。）
- **`.all()` route-owned 边界守卫**（三轮 Medium，方案1）：断言现有全部 `.all()` 业务 handler **不调 `c.notFound()`**（grep/AST 守卫）——锁死「三态 route-owned 识别只覆盖 method-specific route」这一前提；将来新增 `.all()` fallback handler 若调 `c.notFound()`，此测试会红、逼迫先扩展 provenance（见 §4 已知边界 + backlog）。
- **缓存隔离**（二轮 Medium）：同进程创建**两个** `createServer()` 实例（不同 `ServerOptions`，如一个含 external UI、一个不含）→ 各自 unknown 分类基于**自己**的 `server.routes`，不串味（证影子 router 非模块级单例）。
- **子应用挂载**：plain Hono 与 OpenAPIHono 子应用 `.route()` 挂载的路由均可分类。
- **大小写敏感 path**：确认与 Hono 匹配语义一致。
- **级别分发**：`silent` → 断言 consola 未被调用；各级别 → 对应 consola 方法且行内容匹配；经真实 consola level gate 后 bus/FileSink 的可观测结果；**一次请求只产生一次 unknown 日志**（finalizer 幂等）。
- **wire contract**：404 `{ "error": "Not Found" }`、405 `{ "error": "Method Not Allowed" }` + `Allow` 头（完整 HTTP golden）。
- **默认值 / 配置校验 / 热重载**：无配置两类均 `warn`；非法级别值 → strip 用默认（`validateConfig`）/ `PUT` 非法值 → structured 400（`validateConfigInput`）；改 config → 下一请求生效；**字段级 `null` 删除**（二轮 Medium）：`PUT` 先设 `error/info`，再对其中一个 key 写 `null` → 该字段恢复 `warn`、另一字段保留有效值；**`PUT` 删除整个 section → 恢复 `warn/warn`**（`resetConfigManagedState` 路径）。
- **探针不变**：favicon / devtools 仍 204、不打日志。

## 9. 风险与开放问题

- **依赖 Hono 公开 `server.routes` + 自建 TrieRouter**：`server.routes`（`RouterRoute[]`）、`server.router`、`TrieRouter` 在 Hono `.d.ts` 里**均是公开类型**（helper 不需 `any`）。但**仍不能直接用 `server.router` 做 match**——全局中间件 `ALL /*` 污染（PoC 轮2 证），故从 `server.routes` 派生影子 router 是正确性要求。剩余风险：Hono 未来若改变 `.route()` 展平行为，需复验——低概率，§8 的「子应用挂载」「缓存隔离」测试可及早发现。**注意**：不设「业务路由 method 均非 ALL」的守卫（项目本就有合法 `.all()` 业务路由，见 §4/§8）。
- **影子 router 探测开销**：每个 unknown endpoint 需 ≤ candidate-method 数次 `shadow.match`（影子 router 构建一次性 + 按 server 实例缓存）。unknown endpoint 本就是异常路径、低频，开销可忽略。`silent` 只跳过 consola 调用、不跳过分类（见 O1）。
- **开放问题 O1**：`not_found` 与 `method_not_allowed` **都** silent 时，是否仍执行 405 拆分（返回 405+Allow）？
  - 倾向：**仍拆分**。405+Allow+body 是**响应正确性**改进，不应被「日志开关」耦合——日志级别只控制打不打日志、不控制返回什么状态码。silent 只跳过 consola。
  - 已按「仍拆分」定，记录备用户否决。
- **O2 — CORS OPTIONS 归属（用户已裁决：保留现状）**：全局 `cors()` 对**所有** OPTIONS 返回 204，unknown OPTIONS 不到 notFound、不进本管线。**用户裁决 (a) 保留现状**：把「全局 OPTIONS 204」列为明确例外/非目标（§2），§8 断言其行为。代价「任意路径 OPTIONS 永远伪成功」是可接受的诊断盲区。未采纳的 (b) 收窄 CORS（只豁免 preflight-shaped 请求——即带 `Origin` + 非空 `Access-Control-Request-Method` token；注意这只判「结构像 preflight」，不代表 CORS 策略允许该 method）留作 backlog 记录，reviewer 与我原倾向 (b)，但它触及既有 CORS 行为，用户选择最小改动。

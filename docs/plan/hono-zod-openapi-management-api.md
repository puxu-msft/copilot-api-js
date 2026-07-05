# 计划:引入 @hono/zod-openapi(管理 API)+ 全量依赖升级

> **实施状态：已完成**
> **落地**：—
> **现状锚点**：DESIGN 路由表 `/openapi.json`+`/docs` 行；`src/routes/openapi.ts`
> **备注**：Part 1 依赖升级 + Part 2 OpenAPI 3.1+Scalar 全落地，范围扩至全 API 表面（两档保真度）

## Context(为什么做)

本项目目前没有任何 OpenAPI/JSON schema——API 的"事实来源"只有 `docs/DESIGN.md` 的路由表。对外的 OpenAI/Anthropic/Gemini 兼容端点镜像三家**上游既有契约**(用户应参考上游官方 spec),但项目**自有的管理 API**(`/api/*` + `/history/api/*`)没有任何机器可读契约,也没有交互式文档。

用户要求:
1. 引入 `@hono/zod-openapi`,为**管理 API**生成 OpenAPI 3.1 spec,并挂 **Scalar UI**(`@scalar/hono-api-reference`)+ `/openapi.json` 端点。
2. 所有库用**最新版**,并**趁机把现有依赖都升级试试**。

预期结果:管理 API 有机器可读 OpenAPI 3.1 文档 + 浏览器交互页;全部依赖升至最新稳定版(undici 除外,见下);typecheck/test/lint/build 全绿。

利好:本项目已在用 zod v4(`src/lib/config/schema.ts`)+ `z.toJSONSchema` 生成 config schema 的先例,引入 zod-openapi 在依赖与风格上是顺的。

---

## Part 1 — 依赖升级(先做,落到最新绿基线)

### 🔴 硬约束:undici 保持 7.x,绝不升 8
DESIGN.md「运行时兼容」+ 记忆 `reference-bun-fetch-tcp-keepalive` 已实证:**undici 8 的 `index.js` 顶层 eager 构造 CacheStorage,在 Bun 1.3.14 加载即崩**。`undici` 保持 `7.28.0`(已是最新 7.x),不动。

### 新增依赖
- `zod` → **提升为直接依赖** `^4.4.3`(当前是 phantom dep:6 处 src/scripts `import { z } from "zod"` 但未登记 package.json,靠 hoist)。这同时修掉一个潜在隐患。
- `@hono/zod-openapi` `^1.4.0`(peers:hono>=4.10 ✓、zod^4 ✓,复用现有 zod 不拉第二份;deps 全纯 JS)。
- `@scalar/hono-api-reference` `^0.11.4`(peers:hono^4.12.5 ✓)。

### 安全 minor/patch 升级(全做,低风险)
`hono` 4.12.26、`@google/genai` 2.9.0、`vue` 3.5.38、`vuetify` 4.1.2、`@anthropic-ai/sdk` 0.105.0、`@playwright/test` 1.61.0、`@vue/eslint-config-typescript` 14.9.0、`@vue/test-utils` 2.4.11、`eslint-plugin-vue` 10.9.2、`knip` 6.17.2、`openai` 6.44.0、`tsdown` 0.22.3、`vite-plugin-vue-devtools` 8.1.3、`vitest` 4.1.9、`vue-tsc` 3.3.5。

### Major 升级(逐个尝试 → 验证门 → 通过则留、需大改/不兼容则单独回退并文档化)
策略对齐用户"都升级试试":每个 major 尝试升,验证门(typecheck/test/lint/build/ui)绿则保留;若需大范围代码改动或有传入不兼容(如 undici 那类),**只回退该一个 dep** 并在 DESIGN.md/memory 记录原因(根因/现象/为何不升)。
- `typescript` 5.9 → 6.0(风险:新 strict 检查、vue-tsc/tsdown 兼容)
- `vite` 7 → 8(风险:前端构建;`@vitejs/plugin-vue`6 / `vite-plugin-vuetify`2 / vitest4 兼容)
- `eslint` 9 → 10(`@echristian/eslint-config@0.0.54` peer 为 `>=9.0.0` 范围允许,但未实测;规则 API 可能变)
- `lint-staged` 16 → 17(低风险)

### Part 1 验证门(执行性改动 → 必须验证)
1. `bun install` 成功;`find node_modules -name binding.gyp` 仍为空(bun-first 审计);确认无第二份 zod。
2. `bun run typecheck` 绿。
3. `bun run test:backend` 绿(全 offline 套件)。
4. `bun run lint:all` 干净。
5. `bun run build`(build:ui + build:backend)成功 + `bun run typecheck:ui` + `bun run test:ui` 绿。
6. 不启服务器(no-auto-server):上游/keepalive 行为不在此 plan 实测,仅靠现有测试兜底。

提交(细粒度):commit 1 = 安全升级 + zod 直接依赖 + undici 保持注释;commit 2(条件)= 通过验证的 major 升级。

---

## Part 2 — 管理 API 的 OpenAPI 3.1 + Scalar

### 覆盖范围(仅管理 API,已与用户确认)
纳入:`/api/status`、`/api/tokens`、`/api/config`(GET `/`、GET/PUT `/yaml`)、`/api/logs`、`/api/models`(internal,GET `/`、`/:model`)、`/api/debug`(POST `dry-run-pipeline`、`dry-run-truncate`)、`/history/api/*`(entries/entries/:id/lineage、DELETE entries、stats、export、conversations、sessions、sessions/:id、DELETE sessions/:id)。可选纳入 `/api/event_logging`(204 静默消费)。
**排除**:OpenAI/Anthropic/Gemini/Azure 兼容端点(镜像上游契约,流式,走 v4 codec/driver——低价值高 churn)。`modelsRoutes`/`anthropicModelsRoutes` 与 `internalModelsRoutes` 是**不同文件**,排除是干净切分。

### 架构(linchpin 已用官方 README 核实)
`OpenAPIHono` 是 `Hono` 的 drop-in 超类;父子都是 `OpenAPIHono` 时,`.route(prefix, child)` 会把子 app 的 def **带 prefix** 合并进父 app 的聚合文档(colon 语法 `:model`/`:id`,项目已是)。

1. **根 app 翻成 `OpenAPIHono`**:`src/server.ts` 的 `createServer` 与 `tests/helpers/test-app.ts` 的 `createFullTestApp`,`new Hono()` → `new OpenAPIHono()`(`.onError/.notFound/.use/.get/.route` 全不变)。两处都建根 app,故 `/openapi.json` 在真实服务器与测试 app 都可用。非管理路由仍是普通 `Hono`,挂上去不贡献 def(无害)。
2. **管理 route 文件翻成 `OpenAPIHono` + `.openapi(createRoute(...), handler)`**:
   - 改动文件:`src/routes/status/route.ts`、`token/route.ts`、`config/route.ts`、`logs/route.ts`、`models/internal.ts`、`debug/route.ts`、`history/route.ts`(仅 `/api/*` JSON 端点加 def,`GET /` 重定向用普通 `.get` 保留——OpenAPIHono 支持混用)。
   - handler 函数体基本不动(仍 `(c) => c.json(...)`),工作量在**为每端点声明 zod 请求/响应 schema**。
   - `z` 从 `@hono/zod-openapi` import(带 `.openapi()` 扩展),**不**从 `"zod"`。
3. **新增 `src/routes/openapi.ts`**:导出 `registerOpenApiDocs(app)`,调 `app.doc31("/openapi.json", { openapi:"3.1.0", info:{ title, version: packageJson.version }, ... })` + 挂 Scalar `@scalar/hono-api-reference` 于 `/docs`。在 `registerHttpRoutes` 末尾调用它(从而自动进 createServer + createFullTestApp)。
   - 端点:spec = `/openapi.json`,UI = `/docs`(与现有 Vue 前端 `/ui` 分离)。

### Schema 编写策略(诚实 + 防漂移)
- 已有 TS 类型的形状(history entry/session/stats，来自 `~/lib/history/store`;model 来自 `~/lib/models/client`)→ 手写 zod + 加类型断言(`type _Check = z.infer<typeof Schema> satisfies XType` 或反向)在 typecheck 期抓漂移,缓解 `single-source-of-truth-types`。
- 真正动态的形状(effective config 全量映射、quota union、config.yaml 透传)→ 用 `z.record`/`z.unknown`/`z.union` + `.openapi({ description })` 诚实标注动态部分,不强行枚举。
- 请求 schema:`PUT /api/config/yaml`(body)、`POST /api/debug/dry-run-*`(body)、`DELETE /history/api/entries`、entries/sessions/export 的 query params。
- 错误响应(404/400/500)给最小 envelope schema。

### 文件级改动汇总
- 改:`src/server.ts`、`tests/helpers/test-app.ts`(根 app 类型)、`src/routes/index.ts`(调 `registerOpenApiDocs`)、上列 7 个管理 route 文件。
- 增:`src/routes/openapi.ts`(doc + Scalar 装配)、可能 per-route `schemas.ts`(或 schema 与 route 同文件)。
- 改:`package.json`(deps)。

### Part 2 验证门
1. `bun run typecheck` 绿(含 schema 的 satisfies 断言)。
2. 新增 `tests/<域>/openapi-spec.http.test.ts`(http 后缀,用 `createFullTestApp`):断言
   - `GET /openapi.json` 200 + `openapi:"3.1.0"` + `info.version` == package version;
   - 关键管理路径(`/api/status`、`/api/config`、`/history/api/entries` 等)出现在 `paths` 且带正确 prefix;
   - 排除的兼容端点(`/v1/messages`、`/v1/chat/completions`)**不**在 paths(锁定 scope);
   - `GET /docs` 200(Scalar HTML)。
3. 现有管理 API http 测试(如 `config-effective-route.http.test.ts`)仍全绿——证明 OpenAPIHono 改造未改运行时行为。
4. `bun run lint:all` 干净;`bun run build` 成功。

提交:commit 3 = `feat(api): OpenAPI 3.1 spec + Scalar UI for management API`。

---

## 收尾(completion-includes-doc-sync)
- DESIGN.md:路由表「基础设施」加 `/openapi.json` + `/docs`;若有 major 被回退,在「运行时兼容」记录原因。
- `docs/` 可加一节或在现有文档补"管理 API 的 OpenAPI 契约位置"。
- memory:若依赖升级踩到新的 Bun/版本坑,提炼为 reference 记忆;undici-8-crash 已有记忆,如仍适用则确认不动。
- 执行期:落地后派 subagent audit(显式裁判轴=长远正确+完整,非 ROI),复核 schema 保真度、scope 边界、根 app 改造对所有路由族无回归。

## 风险与回退
- Major 升级若破坏构建且需大改:回退该单个 dep,文档化(不阻塞其余)。
- OpenAPIHono 改造仅改 route **装配**不改 handler 逻辑,现有 http 测试是回归网。
- Scalar/zod-openapi 是新表面,只挂在管理 API + 文档端点,不碰热路径与 v4 管线。

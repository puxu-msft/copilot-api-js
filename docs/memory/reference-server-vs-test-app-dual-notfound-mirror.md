---
name: reference-server-vs-test-app-dual-notfound-mirror
description: server.ts 与 tests/helpers/test-app.ts 是双份独立 notFound/middleware 定义；改 server 中间件/notFound 行为须用真实 createServer 测（createFullTestApp 是无中间件的简化镜像、测不到）
metadata: 
  node_type: memory
  type: reference
  originSessionId: fb74a31b-6cff-4713-a36e-321578bb68df
---

`src/server.ts` 的 `createServer()` 与 `tests/helpers/test-app.ts` 的 `createFullTestApp()` 各自**独立定义** `notFound` / `onError` / 路由——test-app 是 server 的**简化镜像**，**不含** `cors()` / `trimTrailingSlash()` / config-token 中间件（只有 onError + notFound + registerHttpRoutes + registerOpenApiDocs）。

后果（本次改 `notFound` 三态 405 拆分时踩到）：改 `server.ts` 的中间件/notFound 行为，若用 `createFullTestApp` 测，测的是**旧镜像**、看不到你的改动，且测不到「全局中间件 `ALL /*` 污染 `server.routes`」「trimTrailingSlash 把 404 改 301」等真实合并态交互——正是 spec 要求「用真实 createServer 测」的原因（否则重蹈假通过）。

**用真实 `createServer()` 测是可行的**：其 config-token 中间件里 `ensureValidCopilotToken()` = `copilotTokenManager?.ensureValidToken()`，测试环境无 manager 时 `?.` 短路 no-op，不撞网络。但注意 config 中间件每请求跑 `applyConfigToState()`，会用 config.yaml 覆盖 state——故 level 类测试须经临时 config 文件驱动（`PATHS.CONFIG_YAML` 重定向），不能只 `setUnknownEndpointLogging`。

判据延续 [[feedback-multidim-completeness-audit-before-claiming-done]] 的「传输/中间件分层」维度与 skill `choosing-test-type`：改 server 中间件行为，真相域在「含全部中间件的真实 app」，选 `createServer` 而非 `createFullTestApp`。活范例：`tests/observability/unknown-endpoint-server.it.test.ts`。

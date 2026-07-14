# 405 检测方案 PoC 结论（unknown-endpoint-logging spec §4 基石）

日期：2026-07-14

## 问题
`notFound` 里要区分「路径不存在（404）」vs「路径存在但 method 不对（405）」，需要一个只含真实路由的 method-aware 匹配器。项目路由大量经 `app.route("/prefix", subApp)` 子应用挂载。

## 三轮 PoC（harness 须复制生产接线，否则假通过）

- **轮1（裸 Hono，无中间件）**：直接 `(server as any).router.match(m, path)` 遍历其他 method 判定——**通过**。但 harness 不真实。
- **轮2（OpenAPIHono + `trimTrailingSlash` + `cors` 全局中间件 + 子应用 `.route()`）**：**证伪**。`server.routes` 含 `ALL /*`（全局中间件的 catch-all），导致 `router.match(anyMethod, anyPath)` 对**任何**路径都返回 ≥1 handler（中间件也计入），连 `GET /nonexistent` 都被误判 405。真实路由 `match count=2`（1 middleware + 1 route）印证污染。→ **直接用 `server.router` 的方案在有全局中间件时完全失效。**
- **轮3（影子 router）**：从公开的 `server.routes` 过滤出真实路由（`method !== "ALL"`），去重后 `add` 进一个独立 `TrieRouter`（无 build 锁、可动态 add；RegExpRouter 有 matcher-already-built 锁不适合）。对影子 router 遍历 method 匹配——**全部正确**：`DELETE /v1/messages→405 allow=POST`、`GET /nonexistent→404`、`PUT /users/:id→405`、已注册 method 根本不到 notFound。

## 结论（写入 spec §4）
- 用**影子 TrieRouter**（源自 `server.routes` 里 `method!==ALL` 的真实路由），**不要**直接用 `(server as any).router`。
- 降低了对 Hono 内部 API 的依赖：只用**公开的** `server.routes`（RouterRoute[]）+ 自建 TrieRouter。
- 边缘 case：auto-HEAD / CORS preflight OPTIONS 实际会被 Hono/cors 提前处理、不到 notFound；即便到了，判 405 也语义合理（无害）。
- 构建时机：`server.routes` 在所有路由注册后才完整（`registerHttpRoutes` 在 `notFound` 注册之后运行），故影子 router 必须 **lazy 构建 + 缓存**（首次 unknown endpoint 命中时从 `server.routes` 构建，之后复用；routes 启动后不变，缓存安全）。

## 教训
harness 不复制生产接线（全局中间件）会让 PoC 假通过——[[empirical-verification]] 「探针 harness 须复制生产接线」的又一实例。

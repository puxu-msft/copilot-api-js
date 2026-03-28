# 02-v3 — WS 路由注册：拆分为两个函数

## 背景

Codex 将 WS 路由从 `start.ts` 收入 `routes/index.ts`，实现了"完整路由表在一个文件"的目标。
但当前方案用 Symbol flag + 双调用实现幂等，为一个简单问题引入了不必要的运行时状态。

## 当前实现

```ts
// routes/index.ts
const HTTP_ROUTES_REGISTERED = Symbol("httpRoutesRegistered")
const WS_ROUTES_REGISTERED = Symbol("wsRoutesRegistered")

export function registerRoutes(app: Hono, wsUpgrade?: UpgradeWebSocket) {
  if (!appWithFlags[HTTP_ROUTES_REGISTERED]) { /* HTTP */ }
  if (wsUpgrade && !appWithFlags[WS_ROUTES_REGISTERED]) { /* WS */ }
}
```

```ts
// server.ts:75 — 第一次调用，注册 HTTP
registerRoutes(server)

// start.ts:225 — 第二次调用，注册 WS（HTTP 被 Symbol 跳过）
registerRoutes(server, wsAdapter.upgradeWebSocket)
```

问题：同一函数被调两次，用 Symbol + 类型断言避免重复。读者需要理解"第一次注册 HTTP，第二次注册 WS"的隐式协议。

## 改为方案 B：两个函数

```ts
// routes/index.ts
export function registerHttpRoutes(app: Hono) {
  app.route("/chat/completions", chatCompletionRoutes)
  app.route("/v1/chat/completions", chatCompletionRoutes)
  // ... 所有 HTTP 路由 ...
  app.route("/history", historyRoutes)
  app.route("/ui", historyRoutes)
}

export function registerWsRoutes(app: Hono, wsUpgrade: UpgradeWebSocket) {
  initWebSocket(app, wsUpgrade)
  initResponsesWebSocket(app, wsUpgrade)
}
```

```ts
// server.ts
registerHttpRoutes(server)

// start.ts
const wsAdapter = await createWebSocketAdapter(server)
registerWsRoutes(server, wsAdapter.upgradeWebSocket)
```

## 优势

- 每个函数只调一次，无需 Symbol 守卫
- 无运行时状态，无类型断言
- `wsUpgrade` 是 `registerWsRoutes` 的**必选参数**——类型更准确
- `server.ts` 导出的 app 仍含 HTTP 路由（对未来测试友好）
- 函数名自文档化，不需要注释解释调用协议

## 影响范围

| 文件 | 改动 |
|------|------|
| `src/routes/index.ts` | `registerRoutes` 拆为 `registerHttpRoutes` + `registerWsRoutes`，删除 Symbol 守卫 |
| `src/server.ts:75` | `registerRoutes(server)` → `registerHttpRoutes(server)` |
| `src/start.ts:225` | `registerRoutes(server, ws)` → `registerWsRoutes(server, ws)` |

## 验证

- [ ] `typecheck` + `test` 通过
- [ ] Symbol 相关代码已全部删除
- [ ] `routes/index.ts` 无运行时状态

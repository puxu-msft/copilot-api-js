# 02 — 路由组织统一（P1）

## 问题 1：handler 文件命名不一致

### 现状

| 路由目录 | handler 文件名 |
|----------|---------------|
| `chat-completions/` | `handler.ts` |
| `messages/` | `handler.ts`、`count-tokens-handler.ts` |
| `responses/` | `handler.ts`、`pipeline.ts`、`ws.ts` |
| **`history/`** | **`api.ts`**（唯一例外） |

### 方案

将 `src/routes/history/api.ts` 重命名为 `src/routes/history/handler.ts`。

**影响范围**：仅 `src/routes/history/route.ts` 导入了 `./api`，改为 `./handler`。

---

## 问题 2：WebSocket 路由在 routes/index.ts 之外注册

### 现状

`src/routes/index.ts` 注册了所有 HTTP 路由，但两个 WebSocket 路由在 `src/start.ts` 中注册：

```ts
// start.ts L224-225
initWebSocket(server, wsUpgradeHandler)        // /ws
initResponsesWebSocket(server, wsUpgradeHandler) // /responses 的 WebSocket GET
```

开发者阅读 `routes/index.ts` 无法获得完整的路由表。

### 分析

WebSocket 路由不在 `routes/index.ts` 的原因是它们需要 `wsUpgradeHandler`——这是在 `start.ts` 中创建的 runtime adapter。路由注册和 WebSocket upgrade 绑定有耦合。

### 方案

在 `routes/index.ts` 的 `registerRoutes` 中增加 WebSocket 路由注册，将 upgrade handler 作为参数传入：

```ts
export function registerRoutes(app: Hono, wsUpgrade?: WebSocketUpgradeHandler) {
  // ... 现有 HTTP 路由 ...

  // WebSocket routes
  if (wsUpgrade) {
    initWebSocket(app, wsUpgrade)           // /ws (history broadcast)
    initResponsesWebSocket(app, wsUpgrade)  // /responses WS GET
  }
}
```

`start.ts` 改为：`registerRoutes(server, wsUpgradeHandler)`

这样 `routes/index.ts` 成为唯一的路由注册点。

---

## 问题 3：`/ui` + `/history` 双挂载缺乏文档

### 现状

```ts
// routes/index.ts L47-48
app.route("/history", historyRoutes)
app.route("/ui", historyRoutes)
```

同一个 `historyRoutes` 挂在两个路径上。`/ui` 的存在原因是 `start.ts` 中的启动日志：

```ts
consola.box(`Web UI: ${serverUrl}/ui`)
```

### 方案

在代码注释中明确记录原因：

```ts
// History API + Web UI
// 主路径 /history — API 和静态文件的规范路径
// 别名 /ui — 友好的 Web UI 入口 URL（用于启动日志和用户访问）
app.route("/history", historyRoutes)
app.route("/ui", historyRoutes)
```

---

## 验证

- [ ] `history/api.ts` → `history/handler.ts` 重命名后 `typecheck` 通过
- [ ] WebSocket 路由移入 `routes/index.ts` 后 `test` 通过
- [ ] `/ui` 和 `/history` 路径仍可正常访问

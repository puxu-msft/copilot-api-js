# 02 — 路由组织（P0）

## 问题 1（P0）：`/history/v3` 资源路径断裂

### 已确认事实

**前端构建产物**（`ui/history-v3/dist/index.html`）中的资源引用：

```html
<script type="module" crossorigin src="/history/v3/assets/index-DZFgCOCu.js"></script>
<link rel="modulepreload" crossorigin href="/history/v3/assets/vue-9yVQJs7r.js">
<link rel="stylesheet" crossorigin href="/history/v3/assets/index-f9PPWMQ6.css">
```

所有引用都以 `/history/v3/assets/` 为前缀（由 `vite.config.ts` 的 `base: '/history/v3/'` 决定）。

**后端路由注册**：

- `routes/index.ts:47` — `app.route("/history", historyRoutes)`
- `route.ts:65` — `historyRoutes.get("/assets/*", handler)`

Hono 的 `app.route(path, sub)` 在编译时将 sub-router 的路由与 mount prefix 合并为绝对路径（通过 `mergePath`）。因此实际注册到 router 的模式是 `GET /history/assets/*`。

**路径匹配结果**：

| 浏览器请求 | Router 模式 | 匹配？ |
|-----------|------------|--------|
| `/history/assets/foo.js` | `/history/assets/*` | ✓ |
| `/history/v3/assets/foo.js` | `/history/assets/*` | **✗ — `/v3` 段使匹配失败** |

也就是说：`dist/index.html` 引用的所有 JS/CSS 资源，在当前后端路由下都会 **404**。

### Hono 内部机制（已读源码确认）

`app.route()` 不会在运行时 strip prefix。它在 `hono-base.js:111-124` 调用 `mergePath(this._basePath, r.path)`，将 sub-router 的每条路由预编译为绝对路径注册到 parent router。`c.req.path` 返回的是原始请求的完整 URL path，不做任何裁剪。

handler 内部的 `indexOf("/assets/")` trick 是针对 `/ui` vs `/history` 双挂载的——但前提是 router 模式先匹配成功。`/history/v3/assets/foo.js` 根本不会匹配 `/history/assets/*`，handler 永远不会被执行。

### 影响判断

这意味着**生产模式下**（`NODE_ENV=production`、后端 serve 静态文件），浏览器打开 `/history` 能拿到 `index.html`，但 `index.html` 中引用的所有资源都会 404。UI 无法渲染。

**开发模式**不受影响——`npm run dev:ui` 使用 Vite dev server（端口 5173），不经过后端路由。

### 修复方向

二选一（需用户决定）：

**方案 A**：修改后端路由，增加 `/v3` 前缀处理

```ts
historyRoutes.get("/v3", serveIndexHtml)
historyRoutes.get("/v3/assets/*", serveAssets)
historyRoutes.get("/", redirectToV3)  // /history → /history/v3
```

**方案 B**：修改 Vite base，使构建产物引用 `/history/assets/` 而非 `/history/v3/assets/`

```ts
// vite.config.ts
base: command === 'serve' ? '/' : '/history/'
```

同时需要调整 router 的 `createWebHashHistory("/history/v3/")` → `createWebHashHistory("/history/")`

方案 A 保持 `/history/v3` 作为 UI 入口（为将来可能的 v4 留空间），方案 B 更简洁但消除了版本化路径。

---

## 问题 2（P1）：handler 文件命名不一致

| 路由 | handler 文件 |
|------|-------------|
| `chat-completions/` | `handler.ts` |
| `messages/` | `handler.ts` |
| `responses/` | `handler.ts` |
| **`history/`** | **`api.ts`** |

`history/api.ts` 应重命名为 `history/handler.ts`。影响范围仅 `route.ts` 的 import。

---

## 问题 3（P1）：WebSocket 路由不在 routes/index.ts

`/ws` 和 Responses WebSocket 在 `start.ts` 注册。`routes/index.ts` 不反映完整路由表。

方案：将 WS 注册移入 `registerRoutes(app, wsUpgrade)`，或在 `routes/index.ts` 中注释标注完整路由表。

---

## 问题 4（P1）：未注册的路由文件

`src/routes/usage/route.ts`（15 行，导出 `usageRoutes`）存在，但 `routes/index.ts` 未注册。
Git 历史显示 `/usage` 曾注册（commit `c1589b0`），后续被移除（commit `7728f1c`）。

**用户已确认**：该文件应删除，同时更新 `docs/DESIGN.md` 中 `/usage` 路由的描述。

---

## 验证

- [x] `/history/v3` 路径匹配行为已确认（Hono 源码级验证：`mergePath` 编译为 `/history/assets/*`，不匹配 `/history/v3/assets/*`）
- [x] `dist/index.html` 确认引用 `/history/v3/assets/...`（构建产物实际检查）
- [x] `usage/route.ts` 存在且未注册，用户确认应删除
- [ ] 修复方案（A 或 B）经用户确认后实施
- [ ] `history/api.ts` → `handler.ts` 重命名后 typecheck 通过
- [ ] `usage/route.ts` 删除 + `DESIGN.md` 更新

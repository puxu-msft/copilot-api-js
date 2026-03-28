# 02-v2 — UI 入口统一为 `/ui` — 已完成

## 背景

UI 已从单纯的 history 查看器演变为多功能面板（dashboard、models、logs、usage、history）。
`/history/v3` 是历史遗留命名——当时只有 history UI，且 v3 是前端版本号。
现在 `/ui` 才是反映职责的规范入口。

## 当前状态（Codex Phase 1 修复后）

Codex 实施了方案 A（在 `/history` sub-router 下加 `/v3` 路由），但方向不对。当前代码：

| 位置 | 当前值 | 应改为 |
|------|--------|--------|
| `vite.config.ts:22` | `base: '/history/v3/'` | `base: '/ui/'` |
| `router.ts:4` | `createWebHashHistory("/history/v3/")` | `createWebHashHistory("/ui/")` |
| `routes/index.ts:47-48` | `/history` 挂载 API+UI, `/ui` 是别名 | `/history` 只挂 API, `/ui` 挂 UI |
| `route.ts:88` | `redirect("/history/v3")` | 不需要（`/ui` 直接 serve） |
| `route.ts:91,97` | `/v3`, `/v3/assets/*` handler | 移到 UI 路由 |
| `start.ts:228` | `Web UI: ${serverUrl}/history/v3` | `Web UI: ${serverUrl}/ui` |
| `dist/index.html` 资源引用 | `/history/v3/assets/...` | `/ui/assets/...`（rebuild 自动生成） |

## 改动方案

### 1. 拆分 history 路由：API 与 UI 分离

当前 `historyRoutes` 同时承载 API 端点和静态文件服务。拆分为：

- `src/routes/history/route.ts` — 只保留 `/api/*` 端点
- `src/routes/ui/route.ts` — 新建，serve index.html + assets

### 2. 修改路由注册

```ts
// routes/index.ts
app.route("/history", historyRoutes)  // 只有 /history/api/*
app.route("/ui", uiRoutes)            // UI 静态文件
```

### 3. 修改前端配置

```ts
// vite.config.ts
base: command === 'serve' ? '/' : '/ui/',

// router.ts
history: createWebHashHistory("/ui/"),
```

### 4. 修改 Vite dev proxy

```ts
// vite.config.ts — proxy 也需更新
proxy: {
  '/history/api': { target: 'http://localhost:4141' },
  '/api': { target: 'http://localhost:4141' },
  '/ws': { target: 'ws://localhost:4141', ws: true },
  '/models': { target: 'http://localhost:4141' },
}
```

### 5. 清理 Codex 的 /v3 路由

删除 `route.ts` 中的 `/v3`、`/v3/assets/*` handler 和 redirect。

### 6. 更新启动日志

`start.ts` 中 `consola.box(\`Web UI: ${serverUrl}/ui\`)`

## 影响范围

| 文件 | 改动 |
|------|------|
| `src/routes/history/route.ts` | 移除静态文件 serve 和 redirect |
| `src/routes/ui/route.ts` | 新建：serve index.html + `/assets/*` |
| `src/routes/index.ts` | 加 `app.route("/ui", uiRoutes)`，改注释 |
| `ui/history-v3/vite.config.ts` | `base: '/ui/'` |
| `ui/history-v3/src/router.ts` | hash base → `/ui/` |
| `src/start.ts` | 日志 URL |
| `ui/history-v3/dist/` | rebuild（资源引用自动变为 `/ui/assets/...`） |
| `tests/e2e-ui/*.spec.ts` | 路径断言更新 |
| `docs/DESIGN.md` | 路由表更新 |

## 不受影响

- `/history/api/*` 端点路径不变
- `/history/ws` WebSocket 路径不变（由 `initWebSocket` 在 `start.ts` 中注册，挂在 root app 的 `/ws`）
- 前端 `api/http.ts` 的 fetch URL（使用 `/history/api/...` 相对路径）不变
- 前端内部组件、composable、类型——全部不变

## 验证

- [ ] `npm run build:ui` 后 `dist/index.html` 引用 `/ui/assets/...`
- [ ] 生产模式访问 `/ui` 返回 index.html
- [ ] 生产模式访问 `/ui/assets/...` 返回 JS/CSS
- [ ] `/history/api/entries` 仍然正常
- [ ] `typecheck` + `typecheck:ui` + `test` + `test:ui` 通过
- [ ] E2E 测试路径断言更新后通过

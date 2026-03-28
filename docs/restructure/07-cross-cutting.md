# 07 — 跨领域问题（P2）

## 问题 1：前后端类型耦合

### 现状

前端通过 `~backend` 别名直接导入后端源码中的 TypeScript 类型：

```ts
// ui/history-v3/src/types/index.ts
export type { HistoryEntry, ... } from "~backend/lib/history/store"

// ui/history-v3/src/types/ws.ts
export type { WSMessage, WSMessageType } from "~backend/lib/history/ws"
```

这是 CLAUDE.md 原则 5（类型单一权威来源）的体现，设计上是正确的。

### 已知 workaround

`src/lib/history/ws.ts` 使用相对路径 `../ws` 而非项目别名 `~/lib/ws`，
因为 `vue-tsc` 不解析 `~/*` 别名（它只识别前端 tsconfig 中定义的别名）。

### 风险

- 后端重构 `lib/history/store.ts`（如 01 中的拆分）会影响前端 import 路径
- 但只要 barrel re-export 保持 `store.ts` 路径有效，前端不受影响

### 建议

- **01 拆分 history/store.ts 时**，确保 barrel 保留所有 52 个 export
- **ws.ts 的相对路径 workaround**：在代码注释中说明原因，避免后续被"修正"

---

## 问题 2：静态文件服务路径

### 现状

Vite 构建配置：
```ts
base: command === 'serve' ? '/' : '/history/v3/'
```

后端静态文件服务（`routes/history/route.ts`）：
```ts
historyRoutes.get("/", ...)         // 返回 index.html
historyRoutes.get("/assets/*", ...) // 从 dist/ 下查找
```

路由挂载在 `/history`，所以实际路径是 `/history/assets/*`。
但 Vite 构建的 `index.html` 中资源引用前缀是 `/history/v3/assets/…`。

### 分析

实际上没有路径不匹配问题——因为 Vite 的 `base` 只影响 `index.html` 中的资源引用路径前缀，
而 `index.html` 是通过 `/history/` 路径访问并读取文件内容返回的。
浏览器请求 `/history/v3/assets/foo.js` 时，不会匹配 `/history/assets/*` handler——
它会请求 `/history/v3/assets/foo.js`，这不在后端路由中。

**这是一个实际存在的路径匹配问题**。之所以目前能工作，是因为 `dist/` 目录作为构建产物提交到了仓库，
后端 `resolveUiDir` 找到的是 `ui/history-v3/dist/`，而 Vite 构建时 `base: '/history/v3/'`
使得 `dist/index.html` 中引用 `/history/v3/assets/…`，但 `/history/v3/assets/*` 路径
实际由 `/history` 路由的 `/v3/assets/*` 子路径匹配——因为 Hono sub-router 匹配的是去掉 mount prefix 后的路径。

**需要验证**：确认 Hono sub-router 对 `/history/v3/assets/foo.js` 请求的路由匹配行为。

### 建议

- 添加启动时检查：`ui/history-v3/dist/index.html` 不存在时打印警告
- 在 `route.ts` 中添加注释说明 base path 对应关系

---

## 问题 3：Vite proxy 硬编码端口

### 现状

`ui/history-v3/vite.config.ts`：
```ts
proxy: {
  '/history/api': { target: 'http://localhost:4141' },
  '/ws': { target: 'ws://localhost:4141', ws: true },
  '/api': { target: 'http://localhost:4141' },
  '/models': { target: 'http://localhost:4141' },
}
```

端口 4141 是硬编码的，如果后端启动在其他端口，前端 dev 代理不工作。

### 建议

从环境变量读取：

```ts
const backendPort = process.env.COPILOT_API_PORT ?? '4141'
const backendUrl = `http://localhost:${backendPort}`

proxy: {
  '/history/api': { target: backendUrl },
  // ...
}
```

低优先级改进，当前 4141 是项目默认端口。

---

## 验证

- [ ] 确认 Hono sub-router 对 `/history/v3/assets/*` 的路径匹配行为
- [ ] 确认 barrel re-export 后前端 `~backend` import 不受影响

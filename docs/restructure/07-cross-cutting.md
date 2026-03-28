# 07 — 跨领域问题（P2）

## 前后端类型共享（非问题，记录注意事项）

前端通过 `~backend/lib/history/store` 和 `~backend/lib/history/ws` 导入后端类型。
这是 CLAUDE.md 原则 5（类型单一权威来源）的体现，设计上是正确的。

**注意事项**：01 拆分 `history/store.ts` 时，必须保持 barrel re-export 有效（当前前端 re-export 31 个类型），否则前端 type-check 会断。

`src/lib/history/ws.ts` 使用相对路径 `../ws` 而非 `~/lib/ws`，代码注释已说明原因（vue-tsc 不解析 `~/*` 别名）。

---

## 问题：Vite proxy 硬编码端口

`ui/history-v3/vite.config.ts` 中 4 个 proxy 规则全部硬编码 `localhost:4141`。

建议：

```ts
const backendPort = process.env.COPILOT_API_PORT ?? '4141'
const backendUrl = `http://localhost:${backendPort}`
```

低优先级。4141 是项目默认端口，绝大多数场景不需要改。

---

## 不再包含的内容

### 静态文件服务路径

已移至 [02-route-organization.md](02-route-organization.md) 作为 P0 处理。

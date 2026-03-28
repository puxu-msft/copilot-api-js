# 07 — 跨领域问题（P2）— 已完成

## 完成状态

| 项目 | 状态 | 结果 |
|------|------|------|
| 前后端类型共享注意事项 | ✓ 已确认 | 保持后端 `history` barrel 作为类型单一来源 |
| Vite proxy 端口配置 | ✓ 已完成 | `ui/history-v3/vite.config.ts` 已支持通过环境变量覆盖后端端口 |
| `sanitize-system-reminder` shim 清理 | ✓ 已完成 | 消费者已直接改为使用 `~/lib/system-prompt` |

## 前后端类型共享（非问题，记录注意事项）

前端通过 `~backend/lib/history/store` 和 `~backend/lib/history/ws` 导入后端类型。
这是 CLAUDE.md 原则 5（类型单一权威来源）的体现，设计上是正确的。

**注意事项**：01 拆分 `history/store.ts` 时，必须保持 barrel re-export 有效（当前前端 re-export 31 个类型），否则前端 type-check 会断。

`src/lib/history/ws.ts` 使用相对路径 `../ws` 而非 `~/lib/ws`，代码注释已说明原因（vue-tsc 不解析 `~/*` 别名）。

---

## 问题：Vite proxy 硬编码端口

该问题已处理。`ui/history-v3/vite.config.ts` 不再把后端端口写死在 proxy 中。

实际方案：

```ts
const backendPort = process.env.COPILOT_API_PORT ?? '4141'
const backendUrl = `http://localhost:${backendPort}`
```

4141 仍是默认值，但现在不再阻塞本地非默认端口调试。

---

## 不再包含的内容

### 静态文件服务路径

已移至 [02-route-organization.md](02-route-organization.md) 作为 P0 处理。

> **⚠️ 已归档（2026-06-28）——陈旧的 2026-04-14 文档审查快照，勿当当前状态依据。** 见同目录 [README.md](README.md)。
> 本快照对 docs/shutdown.md 的多项 ✅ 已失效（memory-pressure 已删、consumers.ts→sinks、WS-关闭移至 Phase 4）。其"漏 executing 状态"发现 2026-06-28 重新核验仍有效、**已修进活 docs/shutdown.md**。

# shutdown.md 实施状况

> 审查日期：2026-04-14
> 对照源码验证 docs/shutdown.md 中每项声明的准确性

## 总体评价：准确，状态机遗漏 `executing` 状态

---

## 逐项验证

### 1. 四阶段优雅关闭

**状态：✅ 准确**

`src/lib/shutdown.ts` 实现 4 阶段：Phase 1（行 227）、Phase 2（行 279）、Phase 3（行 294）、Phase 4（行 320）。

### 2. Phase 1 操作清单

**状态：✅ 准确**

| 文档声称 | 代码位置 | 状态 |
|---------|---------|------|
| 停止接受新请求 | `_isShuttingDown = true`（行 228） | ✅ |
| 标记 draining | 同上，中间件使用 `getIsShuttingDown()` | ✅ |
| 停止后台服务 | `stopRefresh()`（行 243）、`stopMemoryPressureMonitor()`（行 244） | ✅ |
| 关闭 WS 客户端 | `closeWsClients()`（行 249） | ✅ |
| 排空 rate limiter | `rateLimiter.rejectQueued()`（行 256） | ✅ |
| 停止监听 | `server.close(false)`（行 267） | ✅ |

### 3. Phase 2/3/4 — ✅ 准确

- Phase 2：`shutdownGracefulWait` 默认 60 秒（`state.ts` 行 475）
- Phase 3：`shutdownAbortWait` 默认 120 秒（`state.ts` 行 476），abort signal（行 303）
- Phase 4：`server.close(true)`（行 325）+ `peekUpstreamWsManager()?.closeAll()`（行 332）

### 4. 信号升级表

**状态：✅ 准确**

`handleShutdownSignal()`（行 358-406）与文档表格完全一致：
- Phase 1 → 忽略（行 365）
- Phase 2 → 升级到 Phase 3（行 373）
- Phase 3 → 升级到 Phase 4（行 378）
- Phase 4 → `exitFn(1)`（行 384）
- Finalized → 忽略（行 389）

### 5. `bun run --watch` 双信号注意 — ✅ 准确（行 367 注释）

### 6. RequestContextManager — ✅ 准确（`src/lib/context/manager.ts`）

### 7. RequestContext 状态机

**状态：⚠️ 遗漏 `executing` 状态**

文档说：`pending → streaming → completed / failed`

实际类型（`src/lib/history/types.ts` 行 5）：
```typescript
type RequestLifecycleState = "pending" | "executing" | "streaming" | "completed" | "failed"
```

`executing` 状态存在于 `pending` 和 `streaming` 之间。`src/lib/context/consumers.ts` 行 142 的 TUI consumer 明确处理此状态转换。

### 8. Consumer 注册 — ✅ 准确（`src/lib/context/consumers.ts`，`registerContextConsumers()` 行 240）

### 9. Stale Request Reaper — ✅ 准确
`staleRequestMaxAge` 默认 600 秒（`state.ts` 行 473），0 禁用（`manager.ts` 行 107）。

---

## 文档未覆盖的功能

| 遗漏项 | 说明 |
|--------|------|
| `executing` 生命周期状态 | 状态机缺少 `pending` → `executing` → `streaming` 的中间态 |
| RequestContext 接口位置 | 接口定义在 `context/types.ts`（行 181），而非 `context/request.ts`（后者是实现） |

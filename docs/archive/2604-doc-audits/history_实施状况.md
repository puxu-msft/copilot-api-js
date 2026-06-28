> **⚠️ 已归档（2026-06-28）——陈旧的 2026-04-14 文档审查快照，勿当当前状态依据。** 见同目录 [README.md](README.md)。
> 本快照对 docs/history.md 的发现 2026-06-28 重新核验：REST 表 sessions/:id(/entries) 路由 + Web UI v1 **仍不存在且漂移更远**（待专门 history.md pass）；DELETE /api/entries 已文档化。MemoryPressureManager ✅ 已失效（2026-06-04 删）。

# history.md 实施状况

> 审查日期：2026-04-14
> 对照源码验证 docs/history.md 中每项声明的准确性

## 总体评价：大体准确，REST API 表有 2 处错误，Web UI v1 不存在

---

## 逐项验证

### 1. Session 识别方式

**状态：✅ 准确**

`src/lib/history/sessions.ts` 行 6-12 定义 `SESSION_HEADER_CANDIDATES` 和 `getSessionIdFromHeaders()`。`resolveResponseSessionId()`（行 59）处理 `previous_response_id`。

### 2. Session 接口字段

**状态：✅ 准确**

`src/lib/history/types.ts` 行 246-256 定义的 `Session` 接口字段与文档完全一致。

### 3. Session header 候选优先级

**状态：✅ 准确**

`src/lib/history/sessions.ts` 行 6-12 的顺序：`x-session-id` → `x-conversation-id` → `x-chat-session-id` → `x-thread-id` → `x-interaction-id`。

### 4. HistoryEntry 时间字段

**状态：✅ 准确**

`src/lib/history/types.ts` 行 169-244：`startedAt: number`（必填）、`endedAt?: number`（可选）、`durationMs?: number`（可选）。

### 5. EntrySummary

**状态：✅ 准确**

`src/lib/history/types.ts` 行 312-340 定义 `EntrySummary`。

### 6. MemoryPressureManager

**状态：✅ 准确**

`src/lib/history/memory-pressure.ts` 实现堆内存监控和 LRU 淘汰。

### 7. historyLimit / historyMinEntries 默认值

**状态：✅ 准确**

`src/lib/state.ts`：`historyLimit: 200`（行 477）、`historyMinEntries: 50`（行 478）。0 表示无限制（`entries.ts` 行 178 确认）。

### 8. REST API 端点

**状态：❌ 有 2 处错误**

对照 `src/routes/history/route.ts` 的实际路由：

| 文档声称 | 实际代码 | 状态 |
|---------|---------|------|
| `GET /history/api/entries` | ✅ 存在 | ✅ |
| `GET /history/api/entries/:id` | ✅ 存在 | ✅ |
| `GET /history/api/sessions` | ✅ 存在 | ✅ |
| `GET /history/api/sessions/:id` | ✅ 存在（内联返回 entries） | ✅ |
| `DELETE /history/api/sessions/:id` | ✅ 存在 | ✅ |
| `GET /history/api/stats` | ✅ 存在 | ✅ |
| `GET /history/api/export` | ✅ 存在 | ✅ |
| `GET /history/api/sessions/:id/entries` | **❌ 不存在** — entries 在 `GET sessions/:id` 中内联返回 | **错误** |
| — | `DELETE /history/api/entries`（清空所有历史）**存在但未文档化** | **遗漏** |

### 9. WebSocket

**状态：✅ 准确**

`src/lib/ws/broadcast.ts`：topics（行 24-25）、5 个事件通知函数（行 192-259）、`/ws` 路由（行 319）。

### 10. Web UI 版本

**状态：❌ v1 不存在**

| 文档声称 | 验证结果 |
|---------|---------|
| v1（原生 HTML/JS，`/history/v1/`） | **❌ 不存在** — 无此路径、无此目录、无此路由 |
| v3（Vue 3 + Vite，`/ui/`） | ✅ 存在 |

代码中唯一的 UI 是 Vue 3 应用，从 `/ui/` 提供服务。v1 可能曾经存在但已被完全移除。

### 11. 前端类型 re-export

**状态：✅ 准确**

`ui/src/types/index.ts` 行 40 从 `~backend/lib/history/store` 导入。`ui/vite.config.ts` 行 36 将 `~backend` 映射到 `../src`。

---

## 文档未覆盖的功能

| 遗漏项 | 说明 |
|--------|------|
| `DELETE /history/api/entries` | 清空所有历史的端点未文档化 |
| session/:id 内联 entries | entries 在 session 详情中内联返回，而非独立端点 |

# History 系统

## 概述

History 系统记录所有 API 请求的完整对话历史，提供 REST API 查询和 WebSocket 实时推送，以及 Web UI 查看界面。

## 数据模型

### Session

一个服务器进程生命周期内的所有请求归入同一个 session（单会话模式）。

```
Session {
  id: string
  startedAt: Date
  entries: HistoryEntry[]
}
```

**设计决策**：由于 Anthropic/OpenAI 协议是无状态的，客户端不传递会话标识符，无法从请求中区分会话。保留完整的 Session 框架，未来客户端支持 session header 时可直接接入。

### HistoryEntry

每个请求对应一个 entry，记录请求 payload、响应、时间线事件等。

## Memory Pressure 管理

`MemoryPressureManager`（`src/lib/history/memory-pressure.ts`）监控 Node.js 堆内存使用：

- 当堆使用率超过阈值时，按 LRU 淘汰旧的 history entries
- `state.historyLimit` 控制最大条目数（默认 200，0 = 无限制）
- `state.historyMinEntries` 控制内存压力下保留的最少条目数（默认 50）

## REST API

| 端点 | 说明 |
|------|------|
| `GET /history/api/sessions` | 列出所有 sessions |
| `GET /history/api/sessions/:id` | 获取 session 详情 |
| `GET /history/api/sessions/:id/entries` | 获取 session 的所有 entries |
| `GET /history/api/entries/:id` | 获取单个 entry |
| `DELETE /history/api/sessions/:id` | 删除 session |

## WebSocket 实时推送

`/ws` 提供实时事件流：

- `entry:created` — 新请求开始
- `entry:updated` — 请求状态更新（流式内容、完成、失败等）
- `entry:deleted` — 条目删除

## Web UI

| 版本 | 技术栈 | 路径 |
|------|--------|------|
| v1 | 原生 HTML/JS | `/history/v1/` |
| v3 | Vue 3 + Vite | `/ui/` |

前端类型统一从后端 re-export（`~backend/lib/history/store`），不重复定义。

相关代码：`src/lib/history/`、`src/routes/history/`、`ui/history-v3/`

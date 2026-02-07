# 设计文档

## 会话管理（Session Management）

### 现状

Anthropic Messages API 和 OpenAI Chat Completions API 都是**无状态协议**——每次请求携带完整对话历史，协议本身没有 session 或 conversation ID 的概念。

客户端（Claude Code、Cursor 等）也不在请求中传递会话标识符。我们能看到的标识信息：

| 来源 | 字段 | 说明 |
|------|------|------|
| Anthropic payload | `metadata.user_id` | 可选的用户标识，不是会话标识 |
| OpenAI payload | `user` | 同上，转换自 `metadata.user_id` |

**没有任何字段可以区分「这个请求属于哪个对话」。**

### 设计决策

由于无法从客户端请求中识别会话，我们采用**单会话模式**：一个服务器进程生命周期内的所有请求归入同一个 session。

- 保留完整的 Session 框架（`Session` 接口、`sessions` Map、`sessionId` 字段、按 session 查询/删除等 API）
- `getCurrentSession()` 始终返回同一个 session，不做超时分割
- 未来客户端支持 session header 时可直接接入，无需重构

### 曾经的方案（已废弃）

之前使用 30 分钟超时启发式分割会话——如果两次请求间隔超过 30 分钟则认为是新会话。这种方式在多客户端同时使用时会产生错误的会话归属，且超时阈值是任意的，所以已移除。

### 未来计划

当客户端开始在请求中传递会话标识（如 `x-session-id` header 或 payload 中的字段），`getCurrentSession()` 应改为基于该标识进行会话路由。届时可能需要：

1. 从请求中提取 session ID
2. 按 session ID 查找或创建 Session
3. 同一 session ID 的请求归入同一 Session

相关代码：`src/lib/history.ts` 中的 `getCurrentSession()` 函数。

## Tool Use 机制

### Anthropic API 的 Tool Use 模型

Anthropic Messages API 有两类工具调用：

1. **用户定义工具（User-defined tools）**
   - 客户端在请求的 `tools` 数组中定义
   - Assistant 生成 `tool_use` 块调用工具
   - User 返回 `tool_result` 块提供结果
   - `tool_use` 在 assistant 消息中，`tool_result` 在 user 消息中

2. **服务端工具（Server-side tools）**
   - Anthropic 后端内置（如 `web_search`、`tool_search`）
   - Assistant 生成 `server_tool_use` 块
   - 后端执行并在**同一条 assistant 消息**中返回结果（如 `web_search_tool_result`、`tool_search_tool_result`）
   - 客户端不参与执行过程

### Tool Use/Result 配对要求

**核心原则：Anthropic API 要求 `tool_use` 和 `tool_result` 必须配对存在。**

- 每个 `tool_use` 块必须有对应的 `tool_result` 块（通过 `id` 和 `tool_use_id` 匹配）
- 孤立的 `tool_use`（没有 `tool_result`）会导致 HTTP 400 错误
- 孤立的 `tool_result`（没有 `tool_use`）同样会导致错误

### 会话续接与工具集变化

在 Claude Code 等客户端中，会话续接（context continuation）时可能出现：

1. **工具集动态变化**：当前请求的 `tools` 数组与历史消息中使用的工具不同
2. **历史工具引用**：消息历史包含对不在当前 `tools` 数组中的工具的 `tool_use` 块

**关键发现：Anthropic API 不要求历史 `tool_use` 引用的工具必须在当前 `tools` 数组中。** 只要配对完整，API 就接受这些历史记录。

### 错误的过滤策略（已修正）

我们曾错误地实现了"unavailable tool filtering"：

```typescript
// 错误的逻辑（已移除）
if (nameMap.size > 0 && !nameMap.has(block.name.toLowerCase())) {
  // 过滤掉引用不在 tools 数组中的工具的 tool_use
  filteredToolUseIds.add(block.id)
  continue
}
```

这种过滤破坏了 tool_use/tool_result 配对，导致 API 报错：
- "Tool reference 'Task' not found in available tools"
- 实际上是因为 `tool_result` 失去了对应的 `tool_use`

### 正确的处理策略

1. **保留所有配对完整的 tool_use/tool_result**，不管工具是否在当前 `tools` 数组中
2. **只过滤孤立的块**：
   - 没有 `tool_result` 的 `tool_use`
   - 没有 `tool_use` 的 `tool_result`
3. **修正工具名大小写**：如果工具在 `tools` 数组中但大小写不同，修正为正确的大小写

相关代码：`src/lib/message-sanitizer/sanitize-anthropic.ts` 中的 `processToolBlocks()` 函数。

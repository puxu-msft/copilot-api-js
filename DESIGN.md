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

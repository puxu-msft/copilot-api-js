# 请求头构建

## GHC 的请求头 (`networking.ts:380-389`)

```typescript
headers = {
  Authorization: `Bearer ${secretKey}`,
  'X-Request-Id': requestId,
  'OpenAI-Intent': intent,
  'X-GitHub-Api-Version': '2025-05-01',
  ...additionalHeaders,
  ...endpoint.getExtraHeaders(location),
}
headers['X-Interaction-Type'] = agentInteractionType
headers['X-Agent-Task-Id'] = requestId
```

GHC 的 API version 按链路分层：
- Chat 主链路：`2025-05-01`
- Token / auth / 内部接口：`2025-04-01`

## 本项目现状

### 已实现 ✅

`copilot-api.ts:54-56` 已包含核心请求头：

```typescript
"openai-intent": opts?.intent ?? "conversation-panel",
"x-github-api-version": COPILOT_API_VERSION,
"x-request-id": randomUUID(),
```

Token 请求使用独立版本号 (`copilot-client.ts:13`)。

此外本项目还有 GHC 没有的 `X-Interaction-Id`（会话级追踪头，`copilot-api.ts:26-28`），在服务器生命周期内保持不变，用于聚合同一实例的所有请求。

### 剩余 Gap

#### `X-Interaction-Type` — P2

**GHC 值**: `conversation-agent` | `conversation-subagent` | `conversation-background`

GHC 用此头区分主请求、子代理请求、后台请求。

**评估**: 本项目作为代理，所有请求对 Copilot API 而言都是"代理请求"。缺少此头不影响功能。如果 Copilot API 未来基于此头做差异化处理（如限流策略），可以补充。

**建议**: 可固定为 `conversation-agent`，或从客户端请求头中提取。

#### `X-Agent-Task-Id` — P2

**GHC 值**: 与 `X-Request-Id` 相同。

**评估**: 用于请求聚合分析。本项目的 `x-request-id` 已提供等价的请求追踪能力。

**建议**: 可与 `x-request-id` 保持一致，实现成本极低。

## Anthropic 特有的头

### `anthropic-version` ✅

本项目已设置为 `2023-06-01`，与 GHC 一致。

### `anthropic-beta` ✅

本项目已实现 `buildAnthropicBetaHeaders()`（`features.ts:117-144`），逻辑与 GHC 对齐：
- 非 adaptive 模型 → `interleaved-thinking-2025-05-14`
- context editing 启用 → `context-management-2025-06-27`
- tool search 支持 → `advanced-tool-use-2025-11-20`

### `X-Model-Provider-Preference`

GHC 内部 A/B 测试用头，**不需要采纳**。

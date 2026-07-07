# 请求头构建

## GHC 现状（9e668cb12 基线）

### Core headers（`networking.ts:380-389`）

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

API version 按链路分层：
- Chat 主链路：`2025-05-01`
- Token / auth / 内部接口：`2025-04-01`

### `anthropic-beta` 合并策略（#4945, 2026-04-03）

本轮关键改动：`ClaudeStreamingPassThroughEndpoint.getExtraHeaders()` 现会将
**SDK 客户端发来的 anthropic-beta** 与 **endpoint 配置注入的 beta**（例如
`context-management-2025-06-27`）合并去重，而不是互相覆盖：

```typescript
if (headers['anthropic-beta']) {
  const allBetas = new Set([
    ...headers['anthropic-beta'].split(',').map(b => b.trim()),
    ...filtered.split(',').map(b => b.trim()),
  ]);
  headers['anthropic-beta'] = [...allBetas].join(',');
} else {
  headers['anthropic-beta'] = filtered;
}
```

修复前：SDK 发来的 beta header 会覆盖 context-management beta，导致 context editing 功能失效（microsoft/vscode#298471）。

## 本项目现状

### Core headers — 已对齐 ✅

`src/lib/copilot-api.ts:48-78` 生成的 header 集合：

| Header | 值 |
|--------|----|
| `Authorization` | `Bearer ${copilotToken}` |
| `x-request-id` | 每请求 UUID |
| `openai-intent` | `conversation-panel` 或 `conversation-agent` |
| `x-github-api-version` | `2025-05-01`（chat）/ `2025-04-01`（token 接口）|
| `X-Interaction-Type` | 与 `openai-intent` 同值 |
| `X-Agent-Task-Id` | 与 `x-request-id` 同值 |
| `X-Interaction-Id` | **本项目独有** — 服务器生命周期内稳定的会话 UUID |
| `user-agent` | `GitHubCopilotChat/0.38.0` |
| `editor-version` | 动态从 GitHub releases 获取 VS Code tag |
| `copilot-integration-id` | `vscode-chat` |
| `x-vscode-user-agent-library-version` | `electron-fetch` |

### `anthropic-beta` — ⚠️ 存在合并缺口

`src/lib/anthropic/features.ts:125-152` 的 `buildAnthropicBetaHeaders()` **只根据模型能力生成** beta header：
- 非 adaptive 模型 → `interleaved-thinking-2025-05-14`
- context editing 启用 → `context-management-2025-06-27`
- tool search 支持 → `advanced-tool-use-2025-11-20`

`src/lib/anthropic/request-preparation.ts:53-64` 组装 header 时**未读取客户端的 `anthropic-beta`**，因此如果客户端（SDK 或自定义调用方）显式发送了其他 beta（如 `token-counting-2024-11-01`、`extended-cache-ttl-2025-04-11`、`output-128k-2025-02-19`），会被我们本地构造的值**静默丢弃**。

**风险评估**：
- Claude Code / Claude Agent SDK 通常不自行附加 beta header（依赖代理决策），所以**当前没有已知客户端受影响**
- Anthropic 官方 SDK 直连时会带 `"anthropic-beta"`，但直连不经过本代理
- 若未来客户端主动使用 `prompt-tools-2024-04-04`、`extended-cache-ttl` 等特性，会被吞掉

**对齐建议**：
仿照 #4945，在 `prepareAnthropicRequest()` 内将客户端请求头的 `anthropic-beta` 与本地 `buildAnthropicBetaHeaders` 的输出做 Set 合并去重。需要在 handler 层传入客户端原始 header。

### Token 接口版本号

`COPILOT_INTERNAL_API_VERSION = "2025-04-01"`（`src/lib/copilot-api.ts:20`），与 GHC 一致。

## `anthropic-version`

本项目硬编码 `2023-06-01`（`request-preparation.ts:60`），与 GHC 一致。

## 不采纳项

### `X-Model-Provider-Preference`

GHC 内部 A/B 测试头。代理作为中间层无需参与模型 A/B 分配。

### `filterSupportedBetas`（GHC）

GHC 有一个 allowlist 过滤未知 beta 以免被上游拒绝。本项目的 `buildAnthropicBetaHeaders` 生成的 beta 集已经是已知安全值；若实施上文的合并策略，可以在合并时对客户端值做同样的 allowlist 过滤。

## 本轮新增对齐项

| # | 项目 | 优先级 | 说明 |
|---|------|--------|------|
| 1 | `anthropic-beta` SDK/本地合并 | P1 | 对应 #4945；当前以代理构造值为准，客户端 beta 被吞 |

# 本项目 ↔ 上游 映射 + 文件地图 + 同步维护（参考）

> **快照 as-of 2026-07-12**——上游路径/文件名随迁移漂移（vscode-copilot-chat 已归档并入 vscode 主仓）；「状态」列的对齐进展也会变。核对前跑 `bash refs/sync-refs.sh` 查 live 源。

## 文件地图（按"想查什么"索引，路径以 `src/` 为基准；新仓库前加 `extensions/copilot/`）

| 想查什么 | 文件 | grep 模式（用上游真名） |
|---|---|---|
| anthropic-beta header / X-Model-Provider-Preference | `platform/endpoint/node/chatEndpoint.ts` | `getExtraHeaders`、`betaFeatures.push`、`anthropic-beta` |
| 模型能力 / beta 启用判断 | `platform/networking/common/anthropic.ts` | `modelSupports`、`isAnthropic*Enabled` |
| context_management 形状与默认值 | `platform/networking/common/anthropic.ts` | `buildContextManagement`、`clear_thinking_2025`、`clear_tool_uses_2025` |
| memory tool | `platform/networking/common/anthropic.ts` | `modelSupportsMemory`、`isAnthropicMemoryToolEnabled` |
| Messages API body / thinking / cache_control | `platform/endpoint/node/messagesApi.ts` | `createMessagesRequestBody`、`thinkingConfig`、`cache_control`、`AnthropicMessagesProcessor` |
| Responses API body | `platform/endpoint/node/responsesApi.ts` | `createResponsesRequestBody`、`OpenAIResponsesProcessor` |
| 模型能力声明 / alias（最新源 alias 在此） | `platform/endpoint/common/chatModelCapabilities.ts`、`endpointProvider.ts` | `capabilities`、`supports`、`alias` |
| 模型别名（仅归档点；最新源已删） | `platform/endpoint/common/modelAliasRegistry.ts` | `ModelAliasRegistry` |
| server tool use / tool 配对 | `extension/agents/node/adapters/anthropicAdapter.ts` | `server_tool_use`、`tool_search` |
| tool search 启用的调用点 | `extension/intents/node/agentIntent.ts` | `isAnthropicToolSearchEnabled` |

BYOK converters（`extension/byok/common/{gemini,anthropic}*Converter.ts`）本项目**不需要**——本项目直连 Copilot，不做 BYOK 格式转换。

## 本项目 ↔ 上游 映射总表

| 上游（`src/`，新仓库加前缀 `extensions/copilot/`） | 本项目 | 状态 |
|---|---|---|
| `chatEndpoint.ts:getExtraHeaders`/`getAnthropicBetaHeader` | `features.ts:buildAnthropicBetaHeaders`(+`mergeAnthropicBeta`) | 四 beta 已对齐（含 extended-cache-ttl） |
| `anthropic.ts:modelSupportsInterleavedThinking` | `features.ts:modelSupportsInterleavedThinking` | 对齐 |
| `anthropic.ts:modelSupportsContextEditing` | `features.ts:modelSupportsContextEditing` | 本项目领先（含 opus-4-7）+ family fallback |
| `chatModelCapabilities.ts:modelSupportsToolSearch`（default-allow） | `features.ts:modelSupportsToolSearch`(=metadata ?? `tool_search_overrides` ?? `toolSearchDefaultAllow`)+全局 `tool_search` 开关 | 已对齐 default-allow（Phase 1，仅镜像 Claude 分支） |
| `anthropic.ts:modelSupportsExtendedCacheTtl`/`isExtendedCacheTtlEnabled` | `features.ts:modelSupportsExtendedCacheTtl` + `request-preparation.ts` cache 管线 | 已镜像（Phase 2，Agent 门用 isAgentCall 近似） |
| `anthropic.ts:isAnthropicContextEditingEnabled` | `features.ts:isContextEditingEnabled` | 对齐 |
| `anthropic.ts:modelSupportsMemory` + BYOK `anthropicProvider.ts` memory 改写 | `features.ts:modelSupportsMemory` + `request-preparation.ts:rewriteMemoryTool` + config `server_tool_memory` | 已镜像（Phase 3，默认关，CAPI 接受性未实测） |
| `anthropic.ts:buildContextManagement`/`getContextManagementFromConfig` | `features.ts:buildContextManagement` | 默认值本项目改为可配 state |
| `messagesApi.ts:createMessagesRequestBody`/`AnthropicMessagesProcessor` | `anthropic/client.ts` | 已覆盖 |
| `responsesApi.ts:createResponsesRequestBody`/`OpenAIResponsesProcessor` | `openai/responses-client.ts` | 已覆盖 |
| `chatModelCapabilities.ts` | `models/endpoint.ts` | 已覆盖 |
| `modelAliasRegistry.ts`（归档点）/ `chatModelCapabilities.ts`(最新) | `models/resolver.ts` | ⚠️ 上游文件已迁移，查最新源 |
| `anthropicAdapter.ts` server tool 处理 | `sanitize.ts:processToolBlocks`(在 `sanitize/tool-blocks.ts`) | 已覆盖 |

## 同步维护

上游归档后，本地 `refs/vscode-copilot-chat/` **不再更新**（`sync-refs.sh` 已注释掉它）。追新一律走 `refs/vscode-copilot-chat-upstream/`（跑 `bash refs/sync-refs.sh`）。每次拉新后核对并同步到本项目：

1. `chatEndpoint.ts` — 新 header / beta 字符串？
2. `anthropic.ts` — `modelSupports*` / `isAnthropic*Enabled` 模型列表变化？新 feature（memory 等）？
3. `chatModelCapabilities.ts` / `endpointProvider.ts` — 能力声明 / alias 逻辑变化（modelAliasRegistry 已并入此）？
4. `messagesApi.ts` / `responsesApi.ts` — body 构建变化？

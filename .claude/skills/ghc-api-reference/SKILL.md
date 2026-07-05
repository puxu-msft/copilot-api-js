---
name: ghc-api-reference
description: "权威参考 GitHub Copilot Chat 扩展源码，核对 GHC API 的请求格式、anthropic-beta header、模型能力检测（thinking/context-editing/tool-search/memory）、context_management、Messages/Responses body 构建等官方实现。本地冻结副本在 refs/vscode-copilot-chat/（上游已归档），活跃源码已迁入 microsoft/vscode 的 extensions/copilot/src/（用 sparse-checkout 拉取，见 refs/sync-refs.sh）。使用场景：(1) 新增/核对 beta feature 或模型能力 (2) 验证本项目 features.ts/client.ts 与官方一致 (3) 调试 Copilot 返回意外响应 (4) 新模型上线时同步官方判断逻辑。"
---

# GHC API 权威参考：GitHub Copilot Chat 扩展源码

## 这份参考是什么、为什么重要

GitHub Copilot Chat 扩展的源码是 **GHC API 行为的定义者**——它决定向上游 Copilot 发什么 header、启用哪些 `anthropic-beta` feature、对每个模型启用什么能力、`context_management` 怎么构建。**本项目（copilot-api-js）是模仿者**，其 `src/lib/anthropic/features.ts`、`client.ts`、`models/` 等模块都镜像自此源码。

凡涉及与 Copilot API 交互的实现/调试，**以此源码为准**，而非凭记忆或猜测。

## ⚠️ 上游已归档迁移（2026-05-20）—— 这是 skill 必须先讲清的事

原仓库 `microsoft/vscode-copilot-chat` **已归档**，最后一次提交即归档通知（commit `5863f5a`，2026-05-20 "Add archive notice"）。活跃开发**已并入 VS Code 主仓库 `microsoft/vscode`**，源码位于 `extensions/copilot/src/`。

| | 旧（归档·冻结） | 新（活跃） |
|---|---|---|
| 仓库 | `microsoft/vscode-copilot-chat` | `microsoft/vscode` |
| 源码根 | `src/` | `extensions/copilot/src/` |
| 本地副本 | `refs/vscode-copilot-chat/`（symlink，冻结在归档点） | `refs/vscode-copilot-chat-upstream/`（sparse-checkout，已就位；`bash refs/sync-refs.sh` 增量更新） |
| 子树大小 | — | 仅 `extensions/copilot/src` 约 49M（整仓 GB 级，**禁止整仓 clone**） |

目录布局**基本一一对应**：旧 `src/platform/...` ↔ 新 `extensions/copilot/src/platform/...`。本文档路径以 `src/` 为基准，在新仓库前面加 `extensions/copilot/`。

### 双向漂移：本地冻结副本 ≠ 最新源 ≠ 本项目

三者都可能不一致，对照前先想清楚信的是谁：

- **本地冻结副本落后于最新源**（已实测的上游变化）：
  - `endpoint/common/modelAliasRegistry.ts` 在最新源**已删除**，alias 逻辑并入 `chatModelCapabilities.ts` / `endpointProvider.ts`。
  - `anthropic.ts:modelSupportsMemory` 签名从 `(modelId: string)` 变为 `(model: LanguageModelChat | IChatEndpoint | string)`。
  - `messagesApi.ts` / `responsesApi.ts` 的关键导出（`createMessagesRequestBody`、`AnthropicMessagesProcessor`、`createResponsesRequestBody`、`OpenAIResponsesProcessor`）在最新源仍稳定一致。
- **本项目与最新源对齐进展**（2026-07 三特性对齐后）：
  - tool-search 已从"手动 allowlist + config 门控"改为最新源的 **default-allow**（Claude ≥4.5 放行、拒 Haiku + pre-4.5）+ per-model `tool_search_overrides` + 全局 `tool_search` 开关（Phase 1）。归档点的 `TOOL_SEARCH_SUPPORTED_MODELS` / `isAnthropicToolSearchEnabled` 均已在最新源删除。
  - `extended-cache-ttl-2025-04-11`（Phase 2）与 memory tool `memory_20250818`（Phase 3，默认关）已镜像；所有能力匹配器已加 GHC 的 `matches(id) || matches(family)` fallback（Phase 0）。
  - 因此「本项目比冻结副本多某能力/模型」往往是**正确的领先**，不是 bug；要确认请查最新源，别拿冻结副本当裁判。

> 结论：核对**新模型 / 新 beta**一律以最新源为准；查**稳定的协议形状/历史逻辑**用本地冻结副本即可（快、离线）。

## 获取最新源码（sparse，已落地到本仓库 refs/ 内）

最新源码已 sparse-checkout 到 `refs/vscode-copilot-chat-upstream/extensions/copilot/src/`（shallow + sparse，实测子树 ~49M，工作区 ~67M）。`refs/sync-refs.sh` 已内置增量更新块。**首选直接跑脚本**：

```bash
bash refs/sync-refs.sh    # 已存在则 git pull --ff-only 增量更新；不存在则首次 sparse-clone
```

> 该目录受 `refs/.gitignore` 的 `*` 规则忽略，不入库（与其它参考源码一致）。

脚本等价的手动命令（如需单独操作或在别处重建）：

```bash
# 方式 A — sparse-checkout + blob:none（最省带宽；实测子树 ~49M）。可加 --depth=1 省历史。
git clone --filter=blob:none --sparse https://github.com/microsoft/vscode \
  /home/xp/src/refs/vscode-copilot-chat-upstream
cd /home/xp/src/refs/vscode-copilot-chat-upstream
git sparse-checkout set extensions/copilot/src
git pull --ff-only          # 后续增量更新

# 方式 B — 只读单个文件，无需 clone（定点核对最快）
gh api repos/microsoft/vscode/contents/extensions/copilot/src/platform/networking/common/anthropic.ts \
  --jq '.content' | base64 -d

# 方式 C — code search 定位文件在新仓库的路径（确认是否还在 / 已改名 / 已移走）
gh search code --repo microsoft/vscode "isAnthropicToolSearchEnabled" --json path
```

**选择**：日常对比用 A（一次 sparse + `git pull` 增量）；查单点用 B/C；离线/快查用本地冻结副本。

## 核心实现速查（已抽取真实逻辑，不止"去哪找"）

下列结论来自 `src/platform/networking/common/anthropic.ts` 与 `chatEndpoint.ts` 的实读，是 GHC API 行为的关键事实。

### anthropic-beta header 构建（`chatEndpoint.ts:getExtraHeaders`）

仅当 location ∈ {Agent, MessagesProxy} 且走 Messages API 时构建。按条件 push：

| 条件（上游函数） | beta 字符串 |
|---|---|
| `!supportsAdaptiveThinking`（即模型非 adaptive thinking） | `interleaved-thinking-2025-05-14` |
| `supportsToolSearch`（属性，metadata `tool_search` ?? `modelSupportsToolSearch`；config 门控已删） | `advanced-tool-use-2025-11-20` |
| `isAnthropicContextEditingEnabled(endpoint, config, exp)` | `context-management-2025-06-27` |
| `isExtendedCacheTtlEnabled(...)`（模型 + location===Agent + 非 subagent + config；最新源新增） | `extended-cache-ttl-2025-04-11` |

另条件性附加 `X-Model-Provider-Preference` header。`supportsAdaptiveThinking` 来自 `modelMetadata.capabilities.supports.adaptive_thinking`。最新源已把组装重构进 `getAnthropicBetaHeader`（`chatEndpoint.ts`），且 tool-search 的 config 门控（旧 `isAnthropicToolSearchEnabled` + `AnthropicToolSearchEnabled`）已删除、改纯能力驱动 default-allow。

→ 本项目对应 `features.ts:buildAnthropicBetaHeaders`，四个 beta 字符串已对齐（含 `extended-cache-ttl-2025-04-11`，Phase 2）。本项目额外做了**client-beta 合并**（`mergeAnthropicBeta`，对应上游 PR #4945），并发 `X-Initiator: agent|user` + `anthropic-version: 2023-06-01`（在 `request-preparation.ts`）。

### 模型能力判断（`anthropic.ts` / `chatModelCapabilities.ts`，全部 `string` 入参先 `.toLowerCase().replace(/\./g,'-')` 归一；最新源全部 `matches(id) || matches(family)`）

| 上游函数 | 命中模型前缀（归一化后） | 本项目对应 |
|---|---|---|
| `modelSupportsContextEditing` | haiku-4-5 / sonnet-4(-5/-6) / opus-4(/-1/-5/-6)；**含 `1m` 的变体返回 false** | `modelSupportsContextEditing`（含 opus-4-7；已加 family fallback） |
| `modelSupportsInterleavedThinking` | sonnet-4(-5) / haiku-4-5 / opus-4-5 | `modelSupportsInterleavedThinking` |
| `modelSupportsMemory` | fable-5 / haiku-4-5 / sonnet-4(-5/-6) / opus-4(/-1/-5/-6/-7/-8) | **已镜像**（`features.ts:modelSupportsMemory` + config `memory_tool` 开关默认关，Phase 3） |
| `modelSupportsExtendedCacheTtl` | fable-5 / opus-4-5..8 / sonnet-4-5/6 / haiku-4-5（比 memory 窄） | **已镜像**（`modelSupportsExtendedCacheTtl` + config `extended_cache_ttl`，Phase 2） |
| `modelSupportsToolSearch`（default-allow：Claude ≥4.5 放行，拒 Haiku + pre-4.5；OpenAI gpt-5.4/5.5 另支） | 见左（config 门控已删） | `modelSupportsToolSearch` = metadata ?? `tool_search_overrides` ?? `toolSearchDefaultAllow`（Phase 1，仅镜像 Claude 分支）+ 全局 `tool_search` 开关 |
| `isAnthropicContextEditingEnabled` | `modelSupportsContextEditing` **且** config mode ≠ `'off'` | `isContextEditingEnabled` |
| `isExtendedCacheTtlEnabled` | `modelSupportsExtendedCacheTtl` + location===Agent + 非 subagent + config | 本项目：模型 + `extendedCacheTtlEnabled` + `isAgentCall`（近似 Agent 门；无 ChatLocation） |
| `isAnthropicCustomToolSearchEnabled` | tool search 已启用 **且** `AnthropicToolSearchMode === 'client'`（embeddings 客户端搜索） | 未镜像（本项目走 server tool search） |

**命名陷阱**：上游最新源**已有** `modelSupportsToolSearch`（迁到 `chatModelCapabilities.ts`，default-allow denylist）；旧归档点是 `isAnthropicToolSearchEnabled` + 常量 `TOOL_SEARCH_SUPPORTED_MODELS`（已删）。grep 最新源用新名。

关键常量（`anthropic.ts`）：
- ~~`TOOL_SEARCH_SUPPORTED_MODELS`~~ 已删除——tool-search 改为 default-allow（`chatModelCapabilities.ts:modelSupportsToolSearch`：deny 非 claude/haiku/pre-4.5，其余 allow）。
- `TOOL_SEARCH_TOOL_NAME = 'tool_search_tool_regex'`、`TOOL_SEARCH_TOOL_TYPE = 'tool_search_tool_regex_20251119'`、`CUSTOM_TOOL_SEARCH_NAME = 'tool_search'`
- memory 原生 tool：`{name:'memory', type:'memory_20250818'}`，仅 BYOK 路径注入、共用 `context-management-2025-06-27` beta（CAPI 路径不注入——本项目经 CAPI，故 `memory_tool` 默认关、CAPI 接受性未实测）。

### context_management 构建（`anthropic.ts:buildContextManagement` / `getContextManagementFromConfig`）

`ContextEditingMode = 'off' | 'clear-thinking' | 'clear-tooluse' | 'clear-both'`。产出 `{ edits: [...] }`：

- `clear-thinking` / `clear-both` 且 thinking 启用 → `{ type:'clear_thinking_20251015', keep:{ type:'thinking_turns', value:1 } }`
- `clear-tooluse` / `clear-both` → `{ type:'clear_tool_uses_20250919', trigger:{ type:'input_tokens', value:100000 }, keep:{ type:'tool_uses', value:3 } }`
- 无 edits → 返回 `undefined`

`getContextManagementFromConfig` 是**独立导出**（不是内联），从 config 读 mode 再调 `buildContextManagement`。本项目 `features.ts:buildContextManagement` 对应，但默认值来自 `state.contextEditing*`（trigger / keepTools / keepThinking 可配），而非硬编码 100000/3/1。

类型定义（`ContextManagement` / `ClearToolUsesEdit` / `ClearThinkingEdit` / `ContextManagementResponse` 等）在 `anthropic.ts` 顶部，是协议权威，本项目类型应与之对齐。

### thinking 配置（`messagesApi.ts:createMessagesRequestBody`）

`thinkingConfig: { type:'enabled'|'adaptive'; budget_tokens? }`：
- `supportsAdaptiveThinking && !explicitlyDisabled` → `{ type:'adaptive' }`（不带 budget）
- 否则有 `maxThinkingBudget && minThinkingBudget` → `{ type:'enabled', budget_tokens }`
- `budget === 0` → thinking 关闭
- 启用且 `supportsReasoningEffort` 非空 → 另配 effort

→ 本项目相关逻辑在 `features.ts:modelHasAdaptiveThinking`（三级判定：metadata `adaptive_thinking` → `max_thinking_budget>0` → 模型名 allowlist opus-4-6/4-7/4-8）+ `legacy-thinking-retry` 反应式策略。

## 文件地图（按"想查什么"索引，路径以 `src/` 为基准）

| 想查什么 | 文件 | grep 模式（用上游真名） |
|---|---|---|
| anthropic-beta header / X-Model-Provider-Preference | `platform/endpoint/node/chatEndpoint.ts` | `getExtraHeaders`、`betaFeatures.push`、`anthropic-beta` |
| 模型能力 / beta 启用判断 | `platform/networking/common/anthropic.ts` | `modelSupports`、`isAnthropic*Enabled`、`TOOL_SEARCH_SUPPORTED_MODELS` |
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
| `anthropic.ts:modelSupportsMemory` + BYOK `anthropicProvider.ts` memory 改写 | `features.ts:modelSupportsMemory` + `request-preparation.ts:rewriteMemoryTool` + config `memory_tool` | 已镜像（Phase 3，默认关，CAPI 接受性未实测） |
| `anthropic.ts:buildContextManagement`/`getContextManagementFromConfig` | `features.ts:buildContextManagement` | 默认值本项目改为可配 state |
| `messagesApi.ts:createMessagesRequestBody`/`AnthropicMessagesProcessor` | `anthropic/client.ts` | 已覆盖 |
| `responsesApi.ts:createResponsesRequestBody`/`OpenAIResponsesProcessor` | `openai/responses-client.ts` | 已覆盖 |
| `chatModelCapabilities.ts` | `models/endpoint.ts` | 已覆盖 |
| `modelAliasRegistry.ts`（归档点）/ `chatModelCapabilities.ts`(最新) | `models/resolver.ts` | ⚠️ 上游文件已迁移，查最新源 |
| `anthropicAdapter.ts` server tool 处理 | `sanitize.ts:processToolBlocks`(在 `sanitize/tool-blocks.ts`) | 已覆盖 |

## 典型工作流

### 新增/核对一个 beta feature
1. 最新源 `chatEndpoint.ts:getExtraHeaders` grep `betaFeatures.push` → 取全部 beta 字符串与启用条件函数。
2. 对启用条件函数（`isAnthropic*Enabled`）进入 `anthropic.ts` 看模型门槛 + config key。
3. 对照本项目 `features.ts:buildAnthropicBetaHeaders` 补齐；注意本项目的 `mergeAnthropicBeta`（别覆盖客户端 beta）。

### 新模型上线
1. **必须用最新源**（sparse 拉取后）：`anthropic.ts` 看四个 `modelSupports*` + `TOOL_SEARCH_SUPPORTED_MODELS` 是否纳入新模型；`chatModelCapabilities.ts` 看能力声明。
2. 对照本项目 `features.ts` 各 allowlist + `resolver.ts`；本项目可能已领先，确认即可。

### 调试「Copilot 返回意外响应」
1. 比对本项目实际发出的 header（`X-Initiator`、`anthropic-beta`、`X-Model-Provider-Preference`、`anthropic-version`）与上游 `getExtraHeaders`。
2. 比对 body：thinking 形状（adaptive vs enabled）、`context_management` edits、cache_control 位置（上游：tools→system→messages，≤4 个断点）。
3. model name 是否正确解析（`resolver.ts`）。
4. 必要时查 history 的 `sseEvents` 看上游原始帧（参见 GHC tool-call text downgrade 类问题）。

## 同步维护

上游归档后，本地 `refs/vscode-copilot-chat/` **不再更新**（`sync-refs.sh` 已注释掉它，rebase 无新提交）。追新一律走 `refs/vscode-copilot-chat-upstream/`（跑 `bash refs/sync-refs.sh`）。每次拉新后核对并同步到本项目（见映射总表）：

1. `chatEndpoint.ts` — 新 header / beta 字符串？
2. `anthropic.ts` — `modelSupports*` / `isAnthropic*Enabled` 模型列表变化？新 feature（memory 等）？`TOOL_SEARCH_SUPPORTED_MODELS` 扩了？
3. `chatModelCapabilities.ts` / `endpointProvider.ts` — 能力声明 / alias 逻辑变化（modelAliasRegistry 已并入此）？
4. `messagesApi.ts` / `responsesApi.ts` — body 构建变化？

# GHC 能力矩阵与协议形状（参考）

> **快照 as-of 2026-07-12**——下表是从上游源码抽取的**示例结论**，不是永恒真相。模型前缀/beta 字符串/能力门槛都是高 churn 项，核对**新模型/新 beta** 一律以 live 源为准（`bash refs/sync-refs.sh` 后查 `refs/vscode-copilot-chat-upstream/extensions/copilot/src/`）；查稳定的协议形状用本地冻结副本即可。

来自 `src/platform/networking/common/anthropic.ts` 与 `chatEndpoint.ts` 的实读。

## anthropic-beta header 构建（`chatEndpoint.ts:getExtraHeaders` / `getAnthropicBetaHeader`）

仅当 location ∈ {Agent, MessagesProxy} 且走 Messages API 时构建。按条件 push：

| 条件（上游函数） | beta 字符串 |
|---|---|
| `!supportsAdaptiveThinking`（模型非 adaptive thinking） | `interleaved-thinking-2025-05-14` |
| `supportsToolSearch`（metadata `tool_search` ?? `modelSupportsToolSearch`；config 门控已删） | `advanced-tool-use-2025-11-20` |
| `isAnthropicContextEditingEnabled(endpoint, config, exp)` | `context-management-2025-06-27` |
| `isExtendedCacheTtlEnabled(...)`（模型 + location===Agent + 非 subagent + config；最新源新增） | `extended-cache-ttl-2025-04-11` |

另条件性附加 `X-Model-Provider-Preference` header。`supportsAdaptiveThinking` 来自 `modelMetadata.capabilities.supports.adaptive_thinking`。tool-search 的 config 门控（旧 `isAnthropicToolSearchEnabled` + `AnthropicToolSearchEnabled`）已删除、改纯能力驱动 default-allow。

→ 本项目 `features.ts:buildAnthropicBetaHeaders`，四 beta 已对齐。额外做 **client-beta 合并**（`mergeAnthropicBeta`，对应上游 PR #4945），并发 `X-Initiator: agent|user` + `anthropic-version: 2023-06-01`（在 `request-preparation.ts`）。

## 模型能力判断（`anthropic.ts` / `chatModelCapabilities.ts`）

全部 `string` 入参先 `.toLowerCase().replace(/\./g,'-')` 归一；最新源全部 `matches(id) || matches(family)`。

| 上游函数 | 命中模型前缀（归一化后） | 本项目对应 |
|---|---|---|
| `modelSupportsContextEditing` | haiku-4-5 / sonnet-4(-5/-6) / opus-4(/-1/-5/-6)；**含 `1m` 的变体返回 false** | `modelSupportsContextEditing`（含 opus-4-7；已加 family fallback） |
| `modelSupportsInterleavedThinking` | sonnet-4(-5/-6，经 bare `sonnet-4` 前缀) / haiku-4-5 / opus-4-5 | `modelSupportsInterleavedThinking`（**vestigial，见下** §interleaved-vs-adaptive） |
| `modelSupportsMemory` | fable-5 / haiku-4-5 / sonnet-4(-5/-6) / opus-4(/-1/-5/-6/-7/-8) | 已镜像（`features.ts:modelSupportsMemory` + config `server_tool_memory` 默认关，Phase 3） |
| `modelSupportsExtendedCacheTtl` | fable-5 / opus-4-5..8 / sonnet-4-5/6 / haiku-4-5（比 memory 窄） | 已镜像（`modelSupportsExtendedCacheTtl` + config `extended_cache_ttl`，Phase 2） |
| `modelSupportsToolSearch`（default-allow：Claude ≥4.5 放行，拒 Haiku + pre-4.5；OpenAI gpt-5.4/5.5 另支） | 见左（config 门控已删） | `= metadata ?? tool_search_overrides ?? toolSearchDefaultAllow`（Phase 1，仅镜像 Claude 分支）+ 全局 `tool_search` 开关 |
| `isAnthropicContextEditingEnabled` | `modelSupportsContextEditing` **且** config mode ≠ `'off'` | `isContextEditingEnabled` |
| `isExtendedCacheTtlEnabled` | `modelSupportsExtendedCacheTtl` + location===Agent + 非 subagent + config | 模型 + `extendedCacheTtlEnabled` + `isAgentCall`（近似 Agent 门；无 ChatLocation） |
| `isAnthropicCustomToolSearchEnabled` | tool search 已启用 **且** `AnthropicToolSearchMode === 'client'`（embeddings 客户端搜索） | 未镜像（本项目走 server tool search） |

**命名陷阱**：最新源**已有** `modelSupportsToolSearch`（迁到 `chatModelCapabilities.ts`，default-allow denylist）；旧归档点是 `isAnthropicToolSearchEnabled` + 常量 `TOOL_SEARCH_SUPPORTED_MODELS`（已删）。grep 最新源用新名。

关键常量（`anthropic.ts`）：
- ~~`TOOL_SEARCH_SUPPORTED_MODELS`~~ 已删——tool-search 改 default-allow（`chatModelCapabilities.ts:modelSupportsToolSearch`：deny 非 claude/haiku/pre-4.5，其余 allow）。
- `TOOL_SEARCH_TOOL_NAME = 'tool_search_tool_regex'`、`TOOL_SEARCH_TOOL_TYPE = 'tool_search_tool_regex_20251119'`、`CUSTOM_TOOL_SEARCH_NAME = 'tool_search'`
- memory 原生 tool：`{name:'memory', type:'memory_20250818'}`，仅 BYOK 路径注入、共用 `context-management-2025-06-27` beta（CAPI 路径不注入——本项目经 CAPI，故 `server_tool_memory` 默认关、CAPI 接受性未实测）。

## context_management 构建（`anthropic.ts:buildContextManagement` / `getContextManagementFromConfig`）

`ContextEditingMode = 'off' | 'clear-thinking' | 'clear-tooluse' | 'clear-both'`。产出 `{ edits: [...] }`：

- `clear-thinking` / `clear-both` 且 thinking 启用 → `{ type:'clear_thinking_20251015', keep:{ type:'thinking_turns', value:1 } }`
- `clear-tooluse` / `clear-both` → `{ type:'clear_tool_uses_20250919', trigger:{ type:'input_tokens', value:100000 }, keep:{ type:'tool_uses', value:3 } }`
- 无 edits → 返回 `undefined`

`getContextManagementFromConfig` 是**独立导出**（不是内联），从 config 读 mode 再调 `buildContextManagement`。本项目 `features.ts:buildContextManagement` 对应，但默认值来自 `state.contextEditing*`（trigger / keepTools / keepThinking 可配），而非硬编码 100000/3/1。类型定义（`ContextManagement` / `ClearToolUsesEdit` / `ClearThinkingEdit` / `ContextManagementResponse`）在 `anthropic.ts` 顶部，是协议权威。

## thinking 配置（`messagesApi.ts:createMessagesRequestBody`）

`thinkingConfig: { type:'enabled'|'adaptive'; budget_tokens? }`：
- `supportsAdaptiveThinking && !explicitlyDisabled` → `{ type:'adaptive' }`（不带 budget）
- 否则有 `maxThinkingBudget && minThinkingBudget` → `{ type:'enabled', budget_tokens }`
- `budget === 0` → thinking 关闭
- 启用且 `supportsReasoningEffort` 非空 → 另配 effort

→ 本项目 `features.ts:modelHasAdaptiveThinking`（三级判定：metadata `adaptive_thinking` → `max_thinking_budget>0` → 模型名 allowlist opus-4-6/4-7/4-8）+ `legacy-thinking-retry` 反应式策略。

## interleaved-vs-adaptive：谁真正驱动 `interleaved-thinking` beta header（核对 as-of 2026-07-23，上游最新提交 340c42d4ec8）

**核心结论：`modelSupportsInterleavedThinking` 在上游和本项目都是 vestigial（无功能调用点）——真正决定 `interleaved-thinking-2025-05-14` beta header 的是 `adaptive_thinking`（取其反）。**

- **上游**：`modelSupportsInterleavedThinking`（anthropic.ts:95）定义存在但 grep 整个 `extensions/copilot/src` **零调用者**。真实门控是 `!supportsAdaptiveThinking`：CAPI 路径 `chatEndpoint.ts:265`（`getAnthropicBetaHeader`）、BYOK 路径 `anthropicProvider.ts:249`（`thinkingBudget && !supportsAdaptiveThinking`）。`supportsAdaptiveThinking` **纯 metadata 驱动**——`chatEndpoint.ts:223 = modelMetadata.capabilities.supports.adaptive_thinking`，上游**无任何 adaptive 模型名 allowlist**。
- **本项目**：`modelSupportsInterleavedThinking`（features.ts:107）由 config 列表 `state.interleavedThinkingModels` 驱动，但同样**无功能消费者**（`src` 内只有定义，beta header 在 features.ts:310 走 `!modelHasAdaptiveThinking`，与上游同构）。
- **有效命中集**：上游 interleaved 函数 = {sonnet-4, sonnet-4.5, sonnet-4.6, haiku-4.5, opus-4.5}；本项目 config 列表 `["claude-sonnet-4","claude-haiku-4-5","claude-opus-4-5"]`（dash-boundary 匹配，`claude-sonnet-4` 连带命中 4.5/4.6）→ **逐字等价**。∴ **interleaved 列表不需要更新，且改它不影响 wire 行为。**

### adaptive_thinking 才是需要盯的旋钮——已实测：tier-1 metadata 生效，allowlist 是纯 fallback

- 上游 metadata 标 `adaptive_thinking:true` 的 5 个：**opus-4.6 / opus-4.7 / opus-4.8 / sonnet-4.6 / sonnet-5**（均 `max_thinking_budget:32000`）。sonnet-4.5 / opus-4.5 / haiku-4.5 无该 flag（有 budget→enabled 型）。
- 本项目 `state.adaptiveThinkingModels`（tier-3 fallback）= `["claude-opus-4-6","claude-opus-4-7","claude-opus-4-8"]`——**缺 sonnet-4.6 与 sonnet-5**。
- **实测裁定（as-of 2026-07-23，live 4141 管理 API `GET /api/models` dump，反映内部 `state.modelIndex`）**：内部 index **完整保留** `capabilities.supports.adaptive_thinking`，5 个 adaptive 模型全部 `true`。∴ `modelHasAdaptiveThinking` 的 **tier-1 metadata 对全部 5 个都命中，根本不走 tier-3 name allowlist**。
  - ⇒ allowlist 缺 sonnet-4.6/sonnet-5 **不是 live bug**——tier-1 已覆盖；缺口仅在「上游 `/models` fetch 失败/滞后、metadata 对某个**新** adaptive 模型静默」时才暴露（此时 reactive `adaptive-thinking-rejection-retry` 也会按上游 400 自愈）。
  - ⇒ **`/models` 无功能缺陷**：OpenAI-compat `/v1/models` 与 `/models` 投影里 `supports:null` 是**客户端投影按 OpenAI schema 精简**（该 schema 本无 rich supports），非内部丢字段；features.ts 消费的内部 index 完好。若要让客户端可见 capabilities 是**另一个 feature**（更富投影），非 bug fix。

### 设计取向（config allowlist 去留——真分叉，待用户裁决）

上游 adaptive 纯 metadata、无 allowlist；本项目 tier-1 亦 metadata、已实测可靠命中。故 config 项 `anthropic.model_capabilities.adaptive_thinking`（schema.ts:711 / config.ts）与 tier-3 name allowlist **可退役为纯 metadata 驱动**。唯一权衡：项目**刻意**把 allowlist 建成 metadata 滞后时的 fallback（features.ts 注释：「fills the gap when an upstream /models payload lags a new release」）——全退役会移除该韧性，改依赖 reactive retry 按上游 400 自愈。三选项：(a) 全退役→纯 metadata；(b) 保留但同步（补 sonnet-4.6/sonnet-5）；(c) 保留 config **override 能力**、只清空 bundled 默认 allowlist（默认纯 metadata、config 仅可选覆盖）。**注意**：任何 `src/lib/models/*` / features.ts / state.ts 改动须待并发会话对该目录的广播式重命名 settle 后、在 clean tree 进行。

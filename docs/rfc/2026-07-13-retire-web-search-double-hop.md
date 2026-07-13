# RFC: 退役 web_search 双跳 + 清理 config server_tool 键

- **状态**：Draft（待对抗审查 + 用户确认后实施）
- **日期**：2026-07-13
- **决策依据**：ADR [2026-07-13-server-tool-positioning-and-web-search-retirement](../decisions/2026-07-13-server-tool-positioning-and-web-search-retirement.md)
- **勘探依据**：keep/delete 边界映射（Explore 勘探 + 亲手复核三承重点：server-tool-filter 共享性、streaming-pump 死导出、poisoned-thinking 双文件）

## 1. 问题陈述

退役 web_search 双跳（服务 0 真实流量的遗留 `[bypass]`），删除其 config 层，连带清理为它推迟的 backlog；**同时严格保留**与双跳无关的载重件（tool_search + server-tool-filter、memory、反应式自愈网、gpt-5.5 web_search_preview）。核心风险是**误删共享载重**，故 RFC 以精确 keep/delete 清单 + commit invariants 为骨架。

## 2. Keep / Delete 清单（每条附验证过的证据）

### 2.1 确凿删除（web_search 专属）

| 组件 | 证据 |
|---|---|
| `src/lib/anthropic/web-search/`（backends/detect/index/orchestrator/synthesize 全目录） | 外部引用仅 `handler-v4.ts` + doc 注释 |
| `src/routes/messages/web-search-handler.ts`、`web-search-direct.ts` | 唯一入口 handler-v4 分支 |
| `handler-v4.ts` 拦截分支 `if (state.webSearchEnabled && payloadHasWebSearch(...))`（`:243-284`）+ imports（`:116,181`）+ `createWebSearchContext` | 删分支后落 `runMessagesDriver` 兜底 |
| `src/lib/anthropic/pipeline.ts` 的 **5 个 legacy 导出**：`runAnthropicPipeline`、`RunAnthropicPipelineArgs`、`buildAnthropicAdapter`、legacy `buildAnthropicStrategies`、`expectNonStreamingResponse` | ⚠️ **文件本体必留**（同 streaming-pump 处理）。已 grep 逐个核实：这 5 个仅 web-search-direct/orchestrator 用。**绝不删的共享导出**（v4 主路径重度依赖）：`createBetaProbe`（5 个 v4 handler：messages/responses/chat-completions/gemini handler-v4 + debug/dry-run）、`BetaProbe`（4 个 codec）、`AnthropicSanitizeFn`（`system-reject-retry` + **保留的 `web-search-not-found-retry:23`** + `reverse-anthropic-rewrite` + anthropic codec）、`splitBetaHeader`（`createBetaProbe` 内部调用）。注：v4 有独立同名 `buildAnthropicStrategies`（`codec/anthropic/strategies.ts:95`），删的是 pipeline.ts 里的 legacy 版 |
| `createLegacyPoisonedThinkingRetryStrategy`（`request/strategies/poisoned-thinking-retry.ts`）| 唯一调用 `pipeline.ts:194`；**注意**：v4 版是 `codec/anthropic/poisoned-thinking-retry.ts`（不同文件，必留） |
| streaming-pump 5 个死导出：`processOneStreamEvent`/`forwardToClient`/`forwardClientFrame`/`startForwardedSseHeartbeat`/`parseStreamEventData` | **已实证**：v4 主路径走 `client-sink.ts` 自有 heartbeat（`:59` 注释「Mirrors」非调用），退役后纯 dead。**推翻 DESIGN.md「别删」措辞**。streaming-pump 文件本体留（含 3 个主路径共享导出） |
| config：`server_tool_web_search` section + `state.webSearchEnabled/webSearchBackend`（schema/compat/config.ts/state/setWebSearchConfig）| 消费者全在删除集内：`webSearchEnabled`→handler-v4 分支；`webSearchBackend`→web-search-handler + config.ts setter |

### 2.2 删 config 键、保留函数骨架（反应式自愈网）

| config 键 | 删 | 留（用户决策：保留自愈网）|
|---|---|---|
| `anthropic.server_tool_strip` | config 定义 + `stripServerTools()` 的 `stripAll` 分支（读 `state.stripServerTools`）| `stripServerTools()` 函数 + learned-cache/hint 源（`request-preparation.ts:579` 主路径活）+ `SERVER_TOOL_TYPE_PREFIXES` |
| `anthropic.server_tool_rewrite` | config 定义 + `resolveServerToolMode` 的 config 源 | `rewriteServerToolBlocks()` + learned 源 + 常驻 `downgradeEmptyEncryptedSearchResults` |

### 2.3 绝对保留（共享载重，误删=破坏活特性）

| 组件 | 为何留 |
|---|---|
| **`src/lib/anthropic/server-tool-filter.ts` 整个文件** | **已实证共享**：`appliesTo:ANTHROPIC` 无条件常驻（`response-rewrite-adapters.ts:269`，邻居均有 `&& state.xxx` 门控唯它没有），tool_search（默认开）强依赖它滤 `server_tool_use`/`tool_search_tool_result` 块。web-search-direct 对它的调用随文件删，过滤器本身留 |
| tool_search 整套（`message-tools.ts` 注入 + `advanced-tool-use` beta + defer_loading + sticky-undeferred）| 默认开、真实活跃 |
| `server_tool_memory` / `memoryToolEnabled` / `rewriteMemoryTool` 全链 | client-tool 透传，实测三绿，与双跳无关 |
| `server-tool-rejection-retry.ts`、`web-search-not-found-retry.ts` | 反应式自愈骨架，触发源（client 直发原生 server tool 被拒）独立于双跳（用户决策保留）|
| streaming-pump 3 导出：`recordUpstreamFrame`/`anthropicStreamErrorType`/`logUpstreamStreamError` | v4 主路径活（`handler-v4.ts:1194,1305,1307`）|
| `keepalive-frame.ts`（含 server_tool_use case）、`retry-meta-feature.ts` | v4 主路径活 |
| `downgradeEmptyEncryptedSearchResults`（常驻兜底）| 退役后无新产源，但历史 echo 可能仍撞；保留过渡（见 §5 OQ2）|
| gpt-5.5 `web_search_preview`（OpenAI/Responses 路径）| 原生透传，与双跳零耦合 |

## 3. Cutover 计划（按 commit，带 invariant）

**全局 invariant（每 commit 后必须成立）**：`bun run typecheck` 绿 + tool_search / memory / 反应式自愈 / Anthropic direct 路径测试全通过 + 无「半破碎中间态」。

### Commit 1 — 断开路由接入点（使双跳不可达）
删 `handler-v4.ts` 的 `if (state.webSearchEnabled && payloadHasWebSearch(...))` 分支，web_search 请求一律落 `runMessagesDriver`。
- **⚠️ 这是唯一的行为切换点**（Commit 2-4 是纯删死码，零行为变化）。切换后，携带原生 `web_search_20250305` server tool 的请求走 v4 主路径 → GHC Anthropic 端点 400 拒绝 → **保留的反应式自愈网**（`server-tool-rejection-retry`）strip 掉 web_search 重试 → 成功返回**无 web_search 结果的降级响应**（非硬失败）。鉴于 0 真实流量（ADR Part 2），可接受。
- **须实测确认的假设**（实施前用探针验，别推断）：GHC 对原生 web_search 声明返回的 400 message 是否命中 `SERVER_TOOL_REJECTION_TABLE` 的 `/the use of the web search tool is not supported/i`（对比 web_fetch 探针得到的是**另一种**措辞 `rejected tool(s): web_fetch`）。若措辞不匹配 → 自愈网**不触发**、请求裸 400 给客户端。**Commit 1 前先发一个原生 web_search 探针确认 400 措辞**（可扩 `exp/server-tool-web-fetch-poc/probe.ts`）；不匹配则本 commit 须同时给 rejection table 补 web_search 的实际措辞行。
- **invariant**：typecheck 绿；非 web_search 行为逐字节不变；web_search config 仍能解析（暂未删，unused）；双跳模块此刻**不可达但仍在**（过渡态无害——无人调用）。

### Commit 2 — 删不可达的 web_search 专属模块
删 `web-search/` 目录、`web-search-handler.ts`、`web-search-direct.ts`、`createWebSearchContext`、legacy `runAnthropicPipeline`（+ pipeline.ts 的 4 个其他 legacy 导出，**保留 createBetaProbe/BetaProbe/AnthropicSanitizeFn/splitBetaHeader**）、legacy poisoned-thinking twin、streaming-pump 5 死导出（连带清理 streaming-pump 变孤儿的 `server-tool-filter` import）。TypeScript 会报出所有残留引用（当提示逐个清）。
- **同 commit 处理两个悬垂测试文件**（审查 §6 抓出，import 将删符号 → 不处理必红）：`tests/anthropic/fake-sse-heartbeat.unit.test.ts`（import `startForwardedSseHeartbeat`）、`tests/anthropic/streaming-abort.http.test.ts`（import `handleDirectAnthropicStreamingResponse`）。**优先 repoint 到 v4 路径保留覆盖**——它们测的行为（synthetic SSE heartbeat 由 `stream_keepalive_ping_sec` 驱动、streaming abort）在 v4 主路径**是活的**（heartbeat 走 client-sink 自有实现，已有 `tests/pipeline/client-sink.unit.test.ts`；streaming abort 走 handler-v4）。repoint 到 client-sink heartbeat + handler-v4 streaming；确无法平移的用例才删。
- **invariant**：typecheck 绿（TS 证无残留引用）；`server-tool-filter` / tool_search / streaming-pump 3 共享导出 / pipeline.ts 4 共享导出 / client-sink heartbeat 未受影响；tool_search + Anthropic direct 测试通过。

### Commit 3 — 删 config server_tool 键（保留反应式函数）
删 `server_tool_web_search` section、`server_tool_strip`、`server_tool_rewrite` 的 schema/config.ts/state 定义 + `stripServerTools` 的 `stripAll` 分支 + `resolveServerToolMode` 的 config 源（`return state.rewriteServerTools` → `return false`）。**compat 层**：把三键从现有 rename 迁移改为 `removeKey(path, message)` 弃用声明（OQ1，先例 compat.ts:159/177/187），旧配置带这些键时**告警但加载成功**（已是 `validateConfig` 不变量，无需新机制）。
- **invariant**：typecheck 绿；不带这些键的 config 正常加载；**带旧键的 config 告警但不崩**（`removeKey` + validateConfig 兜底）；`stripServerTools`/`rewriteServerToolBlocks` 的 learned 源仍活、反应式自愈测试通过。
- **invariant**：typecheck 绿；不带这些键的 config 正常加载；**带旧键的 config 告警但不崩**（config-philosophy：运行时绝不因配置问题杀进程）；`stripServerTools`/`rewriteServerToolBlocks` 的 learned 源仍活、反应式自愈测试通过。

### Commit 4 — 文档 + backlog 同步
DESIGN.md 删 web_search `[bypass]` 行 + 清理各 driver 迁移行的「web_search 旁路暂缓」注解；删 moot backlog 项（§4）；更新 `tool-use.md`；清扫失真注释（`retry-meta-feature.ts:7,9`、`tool-field-rejection-retry.ts:39-46`、`keepalive-frame.ts:5`、`proactive-filter.ts:21,28,68`、`rewrite-server-tool-blocks.ts:5-8`、`message-tools.ts:343` 的「state.stripServerTools global config opt-in」）。归档双跳相关 spec/plan 到 `docs/archive/`。
- **invariant**：跨文档 grep 无悬垂引用——`rg 'web-search-direct|web-search-handler|orchestrateWebSearch|runAnthropicPipeline|webSearchEnabled|webSearchBackend'` 仅剩 exp/ 探针 + 本 RFC/ADR + archive。

### Commit 5 — 全面纠正对 server tool 的错误说法（OQ3，正交于退役但同源）
依 ADR Part 1 的三类模型（server-executed vs 内置 client-executed vs 自定义 client tool），扫清项目内把 client-executed 工具误称 server tool 的措辞。**行为零变化**，纯认知/命名正确性。

**5a — 措辞订正（注释/doc/config，低险）**：
- `compat.ts:245` 「server tools (web_search / **memory** / code_execution …)」→ 去掉 memory（它是 client tool）；`compat.ts:256` 「native server tool」措辞按语境校准。
- `schema.ts:451`、`config.yaml`（server_tool_memory 段）、`state.ts:213`：「native memory_20250818 **server tool**」→ 「native memory_20250818 **typed client tool**（client-executed，仅注入声明供上游驱动）」——消除「称 server tool 又说客户端执行」的自相矛盾。
- `message-tools.ts:333/340/343/350/368` 的「server tool prefix」/「Stripping server tool」注释 → 「API-defined typed tool」（这些前缀含 client-executed 的 text_editor/computer/bash，不全是 server tool）。
- `docs/tool-use.md`、DESIGN.md server tool 小节：补一句三类区分的锚点，指向本 ADR。
- 注：`docs/todo/deferred-backlog.md` memory 探针条目已正确表述（memory=client-executed），不动。

**5b — 符号重命名（行为中性，~10 站点）**：`isServerToolType` / `SERVER_TOOL_TYPE_PREFIXES`（`message-tools.ts:324,334`，被 anthropic-to-cc-request / tool-name-sanitize / detect 等调）返回 true 于 client-executed 工具，名不符实 → 改 `isApiDefinedToolType` / `API_DEFINED_TOOL_TYPE_PREFIXES`（表达「API 预定义 typed 工具」而非「server tool」）。**保持** `isServerToolBlock`/`isServerToolResultType`（server-tool-filter）不变——它们判 `server_tool_use`/`*_tool_result`，是真·server-executed 产物，命名正确。
- **invariant**：typecheck 绿；行为逐字节不变（纯注释 + 中性重命名）；`rg 'server tool'` 剩余命中仅指真 server-executed 或引用 Anthropic 官方术语处。

## 4. Backlog 盘点（moot vs 保留）

| backlog 条目 | 退役后 |
|---|---|
| L3 主动隔离未覆盖 web_search probe/second hop | **删**（无 probe/second hop → moot）|
| web_search hop 缺 tool-field 反应式学习 | **删**（遗留 hop 没了 → moot）|
| server_tool proxy 推广 + 自愈表 web_search-centric 缺口 | **重写**：去掉「照抄 web_search 双跳」参考（参考实现即删）；保留 `SERVER_TOOL_REJECTION_TABLE` 单行缺口 + web_fetch/code_execution 双跳可行性（独立未来特性，指向 exp/ 探针）|
| GHC server_tool_memory 默认关待探针 | **不动**（memory 与双跳无关）|

## 5. Open Questions（须用户拍板才实施）

- **OQ1 — 旧 config 键的兼容处理**：✅ **已定（用户 2026-07-13）：warn-and-continue，且作为通则——所有映射不了、不影响运行的键一律告警并继续。** 核实：这**已是项目现有不变量**（`validation.ts:validateConfig`——未知键经 `.strict()`→`cleanInvalidPaths` 剥除 + `warnIssueOnce` 告警 + 重试解析；兜底空配置绝不崩），**无需为通则改代码**。退役实施：用现成 `removeKey(path, message)`（`compat.ts:126`）把 `server_tool_web_search` / `anthropic.server_tool_strip` / `anthropic.server_tool_rewrite` 三键声明为「已移除 + 指向本 RFC/ADR」的弃用键（**先例**：`immutable_thinking_messages` / `auto_cache_control` / `refusal_recover_text` 同法退役，compat.ts:159/177/187），给出明确「intentionally removed」告警而非泛化「Unknown key (typo?)」。Commit 3 据此加 3 条 `removeKey` + 一个「带旧键的 config 告警但加载成功」测试。
- **OQ2 — `downgradeEmptyEncryptedSearchResults` 是否保留**：✅ **定稿：保留**（用户 2026-07-13：「这是我们对不可控客户端的保护」）——常驻兜底、成本极低，防已存历史会话或不可控客户端 echo 带空 encrypted_content 的合成 web_search_tool_result 撞 400。
- **OQ3 — 纠正项目内对 server tool 的错误说法**：✅ **定稿（用户 2026-07-13 反转为「全面纠正」）**：ADR Part 1 立了正确的三类模型（server-executed vs 内置 client-executed vs 自定义 client tool），据此**全面清扫项目内把 client-executed 工具（memory/computer/text_editor/bash）误称 server tool 的措辞**。列为 **Commit 5**（见 §3）。

## 6. 验证策略

- **删除类重构的 invariant = 「保留件行为不变 + 删除件彻底消失」**，非字节等价（无新行为）。
- **保留件回归**：Commit 2/3 后跑 tool_search 相关测试（`tests/anthropic/` 中 tool_search/defer_loading/server-tool-filter）、memory 探针逻辑、反应式自愈策略单测（`tests/pipeline/server-tool-rejection-retry.unit.test.ts`）。
- **删除件消失**：`web-search/` 测试文件（`tests/anthropic/web-search/`）随源码删；grep 无悬垂引用。
- **config 兼容**：加一个「带旧 server_tool 键的 config 告警但加载成功」的测试（OQ1 落地后）。

## 7. 范围外

- 不改 tool_search 任何行为。
- 不改 memory 任何行为。
- 不改 gpt-5.5 web_search_preview（Responses 路径）。
- 不推广 web_fetch/code_execution（独立未来特性，留 backlog + exp/ 探针）。
- **Commit 5 的 server-tool 措辞纠正是行为中性的**（注释/doc/config 措辞 + 中性符号重命名），不改任何工具处理逻辑（stripServerTools/tool_search/memory 行为不变）。

# 暂缓 backlog（从记忆库归位）

从记忆库降为引用层（2026-07-05）时归位的活 backlog。每条：现状 / 暂缓原因 / 若做需改什么。

## GHC server_tool_memory 默认关 — CAPI 接受性待探针

- **现状**：`anthropic.server_tool_memory` 默认关。GHC 只在 BYOK 直连注入 `memory_20250818`、CAPI 路径不注入，故本项目经 CAPI 发该 server-tool 类型 + `context-management` beta 的**接受性未实测**。
- **实测结论（2026-07-08，探针 `exp/server-tool-memory-probe/`）**：**CAPI（enterprise 账户）接受** `memory_20250818` server tool 声明 + `context-management-2025-06-27` beta —— 上游 2xx（`stop_reason:end_turn`）且响应体**回显 `context_management:{applied_edits:[]}`**，证明特性被主动处理而非静默忽略。wire 由生产 `rewriteMemoryTool`/`buildAnthropicBetaHeaders` 正确产出（`[{"name":"memory","type":"memory_20250818"}]`）。**边界**：① 仅 enterprise 端点确认——默认 individual base URL（`api.githubcopilot.com`）首跑请求**挂起无响应**，individual/business 接受性未确认、不可外推；② 已验 **wire 接受性**，**未**端到端触发 memory 存取（无 `server_tool_use` 块，需触发存取的 prompt 才能验实际行为）。结论详见探针 README `## 结论：接受`。
- **端到端实测（2026-07-08，enterprise，探针参数化 `PROBE_PROMPT`/`PROBE_MAX_TOKENS`）**：**memory 工具端到端被真正调用 · 确认**——诱导 prompt 让上游产出真实 `{"name":"memory","type":"tool_use","input":{"command":"view","path":"/memories"}}` 块（`stop_reason:tool_use`），结构化 tool_use 非文本敷衍。**关键**：memory 是 **client-executed** 工具（`type:"tool_use"` + `caller:{type:"direct"}`，非 `server_tool_use`）——上游只**驱动**（发 view/create 命令），实际 `/memories` 存取由**最终 client**（Claude Code）执行、多轮 tool_result 喂回。故永不会有 memory 的 `server_tool_use`/`applied_edits`。**含义：本项目侧无需自建 memory 后端，只需透传该 tool_use 不拦截**。
- **多轮透传实测（2026-07-08，enterprise，`probe-multiturn.ts`）**：**请求侧管线多轮 memory 往返透传 · 确认**——含 memory `tool_use`（assistant）+ `tool_result`（user）的续接会话经**完整生产请求侧三段**（`preprocessAnthropicMessages` → `runAnthropicPayloadRewrites` → `createAnthropicMessages`，忠实复刻 `handler-v4` 顺序）后，两块**原样保留、`tool_use_id` 配对未乱**（sanitize orphan 计数 0），上游 Hop2 **2xx 续跑到 `end_turn`** 并消费 tool_result；带签名 thinking 块亦逐字透传、未触发 thinking 400。**探针保真教训**：单跳 `probe.ts` 直调 `createAnthropicMessages` 只跑 prepare、**测不到 sanitizer**（生产里 sanitizer 在路由层更早跑），多轮探针复刻三段才真正验到 `processToolBlocks`。翻默认前的请求侧透传残留点消除。
- **决策（用户 2026-07-08）**：**保持默认关**（`server_tool_memory` 不改）。enterprise 已 wire + e2e + 多轮透传**三绿**、可放心手动开；唯一未闭合缺口 individual/business 端点**凭据阻塞、不可测**（本账户是 enterprise），故不全局翻默认。若将来拿到 individual/business 凭据复测通过，可评估 account-type 门控或全局翻默认。
- **权威现状**：skill `ghc-api-reference` + `docs/plan/ghc-feature-alignment-tool-search-cache-ttl-memory.md`。

## stripToolFields 预剥的深层可观测性（history/telemetry 维度）

- **现状**：`stripToolFields`（`message-tools.ts`）剥除未知 custom-tool 字段（如 `eager_input_streaming`）时仅发结构化 `consola.warn`（命名剥除字段 + 受影响 tool 数），与 sibling `stripServerTools` 同档。反应式腿经 `RetryAction.meta.strippedToolFields` 已可达；但**内置默认 / config / cache 的 proactive 预剥是常态路径**（首请求就零 round-trip），它不经重试、不进 history `sseEvents` / request-telemetry 维度。
- **暂缓原因**：`buildWirePayload`（B1/B2 ctx 初始化，非 prepare step）当前无事件发射通道，sibling `stripServerTools` 亦仅 warn；就地新建 telemetry 通道属跨切面改动，超出与 sibling 对齐的范围。对抗审查 M2 提出、判为「决定数据模型的后续项」。
- **若做**：给 prepare 阶段（或 `stripToolFields` 返回值）接一个能到达 history/request-telemetry 的结构化回执（剥除字段集 + 受影响 tool 数 + 来源 builtin/config/cache/hint），前端可选呈现（richest-data-flow）；同时可顺带给 `stripServerTools` 补同款可观测性。遥测架构见 skill `telemetry-architecture`。

## web_search hop 缺 tool-field 反应式学习（遗留管线边界）

- **现状**：`tool-field-rejection-retry` 只注册在 v4 codec 管线（`codec/anthropic/strategies.ts`）;web_search 双跳仍走**遗留** `runAnthropicPipeline`（`web-search-direct.ts` / `web-search/orchestrator.ts`），其策略表**不含**任何 reactive-rejection 策略（server-tool / structured-outputs 亦缺），遗留 adapter opts 也无 `excludeToolFields`。
- **当前行为（已核实无害）**：`stripToolFields` 的**预剥三源**（内置默认 + 端点级学习缓存 + config）经 `prepareAnthropicRequest` 对**两条路径都生效**——`eager_input_streaming` 及主路径已学到的字段在 hop 上照剥，端点级缓存跨路径共享。唯一残余缺口：**全新未知字段首次且仅出现在 web_search hop** 时，该路径裸 400 且不写缓存（几乎不可能——hop 携带与原请求相同 tools，新字段必先经 v4 主路径学到;且 `webSearchEnabled` 默认 OFF）。
- **暂缓原因**：与遗留 hop 简化管线边界一致（本就省略全部 v4 反应式策略）；补齐需给遗留 pipeline 加策略 + adapter opts 透传 `excludeToolFields`，属遗留管线退役范畴。发现方：交付审计 subagent（2026-07-07）。

## L3 主动隔离未覆盖 web_search probe/second hop（遗留管线边界，L2 兜底）

- **根因**：web_search 双跳（`web-search/orchestrator.ts` 的 `callMainModel` / `runFirstHopProbe` / `completeWebSearch`）绕过 v4 driver，直接调 `sanitizeAnthropicMessages`、**不挂 L3 proactive filter**；且该路径 `requestContext: undefined`、无 `env.ctx`（session/agent），拿不到隔离键——这正是 L3 只覆盖 driver 路径 + web_search **direct real-send**（`web-search-direct.ts` 的 `runInitialSanitizationAndRecord`，即 no-search re-dispatch）两个接入点的原因。
- **当前行为（已核实无害）**：中毒的 web_search 会话在每个 probe / second hop 上仍撞 GHC「thinking cannot be modified」400，由 L2 遗留兜底 `createLegacyPoisonedThinkingRetryStrategy`（`pipeline.ts:188`）反应式 strip-all 重试恢复——**结果正确**，但每个此类 hop 都白付一次 400+retry 往返（正是 L3 在其他路径上消除的那笔 round-trip tax）。
- **理想架构**：把 (session, agent) 从 `handleWebSearchCompletion` 一路穿到 orchestrator 的 hop，并把 `stripAllThinkingIfQuarantined` 组合进 hop 的 `sanitize`；或（更干净）把 web_search 双跳整体迁到 v4 driver，让它自动继承 L3 rewrite（order 250），probe/second hop 免费获得主动隔离。
- **为何暂缓**：web_search 是 opt-in/罕用（`webSearchEnabled` 默认 OFF）；L2 已兜住正确性；该路径本就是文档化的 `[bypass]`、排期迁到 driver（迁移即自动修复本项）；把 ctx 穿进 orchestrator 会动到脆弱的 hop 路径。属遗留管线退役范畴，非「因范围大降级」。
- **若做需改什么**：① `web-search/orchestrator.ts` 的 hop sanitize + `handleWebSearchCompletion` 的 ctx 穿线；② 一个 web_search 路径的 L3 集成测试。注意该集成测试当前**缺测试基建**——`runInitialSanitizationAndRecord` 无 store 注入缝（走 `getQuarantineStore()` 惰性单例），而该单例**无 `resetQuarantineStoreForTests` 复位缝**、未登记进 isolated-fixture 的 `RESETTERS`；干净地集成测须先补这个 production 复位缝再登记。**故本次未加 web_search 路径 L3 集成测试**：web_search direct-send 接入点的覆盖当前依赖共享核 `stripAllThinkingIfQuarantined` 的单元测试（`tests/anthropic/quarantine-proactive-filter.test.ts`，测的正是该路径调用的同一 primitive）。发现方：Task 11 交付审查 subagent（2026-07-07）。

## context-edits 回执 telemetry（7d 分布）
- **现状**：`applied_edits` 诊断回执已落地（commit f55fd93，`src/lib/anthropic/applied-context-edits.ts`，流式经 accumulator `message_delta` / 非流式经 handler 顶层，两路发 `recordFeature("context-edits-applied", {count, clearedInputTokens, types})`），进 observability feature 维度计数。
- **暂缓**（用户 2026-06-29"暂时不做"）：接进 `request-telemetry` 做 7d 持久分布（现只 feature 维度计数，无 cleared token 量直方图）；实证开启 `protectStreamingEscalateContext` / `contextEditingMode` 后真有非空 `applied_edits`（当前样本 req_1782713407242_1 全空回执）。
- **原因**：命中率 / 价值未知，先收集 feature 计数再决定是否加 telemetry 维度（YAGNI）。遥测架构见 skill `telemetry-architecture`。

## setup-claude-code CLI 尊重已有配置（+/~/- diff）

- **[已落地 2026-07-08]**（commit `86cb2ff5`）：`writeClaudeCodeConfig()` 现总是 per-file `+/~/-` diff + 确认再写；`--yes` 自动应用、`--dry-run` 只展示不写、非 TTY 无 `--yes` 时 abort（never-swallow：坏 JSON 文件拒 clobber）；纯函数 `computeJsonDiff` / `decideWriteAction` 已抽出并单测。
- **Follow-up（learn-by-analogy，本次未做以守范围）**：`src/setup-codex.ts` 与此同构（也写 `~` 下 JSON config）。`computeJsonDiff` / `decideWriteAction` 已文件无关、可直接复用，建议类比给 setup-codex 套用同一 diff/confirm/`--yes`/`--dry-run`/非 TTY-abort UX。
- **现状（历史）**：`src/setup-claude-code.ts` 写 `~/.claude.json`/`~/.claude/settings.json`。config-respect UX（检测已存在的自定义配置、破坏性覆盖前展示直观 `+/~/-` diff 并确认、区分 essential=默认写 vs extension=仅 opt-in）**未实现、未文档化**——此设计意图原挂在记忆 `feedback_tests_never_touch_real_env` 的一条 How-to 里（该记忆的主旨是测试隔离、此条属跑题内容），记忆降 stub 时归位至此以免丢失。
- **若做**：给 `writeClaudeCodeConfig()` 加 merge/diff 层（读现有 config → 计算 essential/extension 分类 → 展示 diff → 确认再写）；无 CI/守卫，属独立 UX 特性。
- **原因**：非承重、无用户明确需求，先记录待用户决定优先级。

## RFC 数据模型裁剪审计 — 剩余低信号

- **现状**：12 个优先 RFC 已审（2026-06-24，4 并行 subagent + 主线核验）零 richest-data-flow 裁剪违规，3 个 SHOULD-BUILD 全实现（非流式语义残缺检测 / 顶层 `failureReason` 投影 / HTTP2 trailers 捕获，commit `0284935`/`6fd6d4d`/`e30ca33`）。判据已内化进 ADR `docs/decisions/2026-07-05-richest-data-flow.md`。完整审计叙事见 `docs/archive/memory/project-audit-rfcs-data-model-pruning.md`。
- **未审（低信号）**：非优先 RFC（p2.6 / upstream-http2 / tool-call-text-recovery）、observability sinks 的 filter 逻辑、dry-run `fidelity.caveats`（subagent 判为诚实文档非裁剪，可复核）。
- **判据**：字段 / 腿 / per-attempt 描述真实可观测阶段即须完整存（前端可不展示）；区分「裁剪数据模型」（禁止）vs「收敛捕获机制 / 单一 owner」（允许）。

## 前端 lint 未启用 react-hooks / jsx-a11y 规则（全仓 tooling 缺口）

- **现状**：`eslint.config.js` 调 `config({ prettier })` 未开 `reactHooks` / `jsx`（a11y）/ `react` 任一开关；预设 `@echristian/eslint-config` 默认三者 `enabled:false`（插件 `eslint-plugin-react-hooks@5` / `eslint-plugin-jsx-a11y` / `@eslint-react` 已装但未接线）。`eslint --print-config` 实测 resolved rules 里 `react-hooks/rules-of-hooks`、`react-hooks/exhaustive-deps`、`jsx-a11y/*` 全缺，仅 16 条 `react/jsx-*` 排版规则且都 off。
- **根因 / 当前行为**：hooks 依赖数组完整性、受控 state、a11y 标记全无自动化护栏——靠手写 + subagent review 兜底（如 ModelsTable TanStack 重写的 `select` useCallback 缺失是 subagent 抓的，非 lint）。ui-v4 是 hooks 密集子项目，长远正确性应把这类正确性固化为门禁。
- **暂缓原因**：跨切面 tooling 改动，牵动全 monorepo（含存量 Vue `ui/` + React `ui-v4/`）；整仓启用会牵出大量存量告警，需独立审计分批修，不宜塞进单个功能提交（会掩盖功能 diff + 有连累 sibling 包 lint 的风险）。属独立工作项而非「因范围大降级」。
- **若做**：`eslint.config.js` 的 `config({...})` 传 `reactHooks:{enabled:true}` + `jsx:{enabled:true, a11y:true}`（可选 `react:{enabled:true}`）；建议先用 `files` glob 限定 `ui-v4/**/*.{tsx,jsx}` 启用（实测本 PR 新代码零报错），再逐步扩到 `ui/`，逐包清存量告警。发现方：ModelsTable TanStack 重写的 subagent code review（2026-07-07）。

## RFC gap F：token-limit 变体正则 — 无真实 golden body，暂缓（O3 无 golden 不猜）

- **根因**：`parseTokenLimitError`（`src/lib/error/parsing.ts`）只有 2 条正则——OpenAI `prompt token count of N exceeds the limit of N`、Anthropic `prompt is too long: N tokens > N maximum`。理论上还可能存在第三种上游 token-limit 措辞（`max_tokens`-inclusive body、Vertex 措辞的 context-length 400、`context_length_exceeded` code、`maximum context length ... tokens` 等 OpenAI/Vertex 变体），若上游真发这类 body，当前会漏解析 → 落到 `bad_request`，`classify.ts:203-207` 的 400→`token_limit` 分支拿不到 `{current, limit}`，auto-truncate 永不触发。
- **当前行为**：`classify.ts` 400 路径已正确经 `extractTokenLimitFromResponseText`→`parseTokenLimitError` 抽取（已核实，无需另改）；解析成功即路由 `token_limit`、失败即 `bad_request`。接线完整，缺的只是「第三种措辞的匹配能力」。
- **理想架构**：捕获真实上游变体 body 建 golden fixture → 加**精确匹配该真实措辞**的第 3 条正则 → TDD 红/绿。措辞必须来自真实 body，不臆造。
- **为何暂缓（硬门槛未过）**：**穷尽扫描了完整 History 语料**（`~/.local/share/copilot-api/history.db`，425MB + 117MB WAL，704 entries / 2501 stages，只读、zstd 解压全量 blob；另 grep `tests/` `docs/` `exp/` `refs/`）——**没有任何一条当前 2 条正则漏掉的真实 token-limit body**。语料里全部 token-limit 上游拒绝都是 Anthropic `prompt is too long: N tokens > N maximum`（code `model_max_prompt_tokens_exceeded`，如 `1002738 tokens > 1000000 maximum` / `1002484 tokens > 1000000 maximum`），**已被现有 Anthropic 正则命中**。其余 400 body 全非 token-limit（`thinking blocks cannot be modified`、`Unexpected role "system"`、`invalid_reasoning_effort`、`web_search` 相关、502 GitHub unicorn HTML、`stale context reaper` 等）。无 `max_tokens`-inclusive、无 Vertex 措辞、无 `context_length_exceeded`、无 `maximum context length`。按 RFC O3「无 golden 不猜」，**不产出任何投机正则**。
- **若做需改什么**：等真实上游发出第三种措辞并被 history 捕获后——① 从该真实 body 建 golden fixture（放 `tests/error/`）；② 写测试断言 `parseTokenLimitError(<真实 body>)` 返 `{current, limit}`（当前返 `null`）；③ 加**只覆盖该真实措辞**的第 3 条正则（不宽泛猜测）；④ 复跑确认 `classify.ts` 400→`token_limit`→auto-truncate 链路打通（接线已就绪、无需改 classify）。复查手法：只读解压 history blob 扫 `success:false` 的 `rawBody`（本次扫描脚本可复用）。发现方：RFC「反应式上游拒绝协商」P3 task F golden-first gate（2026-07-07）。

## Requests 列表增强 — 收尾 backlog（2026-07-06 分支 feat/requests-list-enhancement 最终评审滚存）

七维筛选 + TableVirtuoso 列表引擎全落地（spec `docs/spec/2026-07-06-ui-v4-requests-list-enhancement.md`、plan `docs/plans/requests-list-enhancement/`）。最终整分支评审判「可合并、无 Critical/Important」，两条合并前建议（H1 守卫测试 + 测试名 overpromise）已补（commit 8f06e678）。以下 Minor 入 backlog：

- **response_sessions 孤儿映射未扫**（`src/lib/history/sqlite/write.ts` `deleteEntries`）：scoped delete 不清 `response_sessions`（该表对 entries_v2 无 FK）。与 `deleteSession` 同款行为、`clearAllEntries` 兜底、无害泄漏（非数据丢失）。spec §9 文字提过。**若做**：`deleteEntries` 内按被删 entry 的 response id 清对应 `response_sessions` 行，或加周期性 orphan sweep。
- **[已修 2026-07-08]** **chip 日期标签 UTC vs popover 本地时区**（commit `e92c6561`）：`request-filters.ts` 的 `fmtDate` 已改用本地时区、与 `DateRangePopover` 一致（epoch 值 / 筛选结果不动，加了时区无关断言）。原问题：非 UTC 时区跨午夜两处显示串可能差一天。
- **HistoryRow 硬编码像素宽**（`ui-v4/src/components/requests/RequestRow.tsx`，服务 Sessions AgentLane）：未用 `COLUMN_WIDTHS` SSOT（不同布局语境，History↔Live 的 M4 红线已满足）。**若做**：AgentLane 若要与 History 表列对齐，改用 COLUMN_WIDTHS。
- **cosmetic**：`selectionClass` 在 HistoryList 与 RequestRow 各一份；清空确认 Modal 删除在途时「取消」按钮未 disabled（删除仍完成、无数据丢失）；列可见性菜单 multiplier 列 label 显示孤立 "×"（表头简写兼作菜单标签）；useRequestFilters 的 `FILTER_KEYS` 手列可派生自 `Object.keys(EMPTY_FILTERS)`。
- **测试覆盖薄**（非正确性）：useRequestFilters 的 clearAll/数值维 round-trip 未单测；useDebouncedCallback 的 fnRef-latest/卸载清理未单测。

## clientResponse.status 固有 settle 时序缺口 — 非流式上游 HTTP 错误路径

- **根因**：非流式上游 HTTP 错误（`await p` 抛 `HTTPError`）在 `src/routes/messages/handler-v4.ts:365-388` 的 handler catch 里当场 `ctx.fail(resolvedName, error)` **自 settle**（`toHistoryEntry` 同步冻结 entry 快照），而客户端最终收到的转发 status 由下游 `forwardError`（`src/lib/error/forward.ts:497`）在 settle **之后**才根据 error 分类决定（4xx/5xx/504…）。故这条路径转发给客户端的 status 无法在快照冻结前被 `setClientResponseStatus` 捕获。与刚补的 499 预响应 client-abort 路径**性质不同**——499 是 abort 前即已知的字面量（在 handler 内决定），可在 abort 快照前 set；而非流式 HTTP 错误的转发 status 是下游决定的，handler catch 时尚不可得。
- **当前行为**：该路径 `entry.clientResponse.status` 为 `undefined`（快照冻结时未 set，observability middleware 的兜底写发生在 self-settled ctx 快照冻结之后 → no-op）。**上游 leg status 仍完整**（`outboundResponse.status` = 真实上游 HTTP 状态，如 429/500），只是「代理转发给客户端的 status」这一维度在此路径缺失。成功路径 + 499 abort 路径 + defer-settle 失败路径（middleware 兜底）均已捕获，仅此一路径缺。
- **理想架构**：重排 settle 时机使转发 status 在快照前可得——两条路子：① 把 `ctx.fail` 推迟到 `forwardError` 决定 status 之后再 settle（handler catch 只暂存 error，由更下游统一 settle）；② `forwardError` 决定 status 后**回灌** `ctx.setClientResponseStatus` 并触发 entry 的 `updateEntry` 补写（clientResponse.status 进 `updateEntry` allowlist）。②更契合现有 self-settle 架构、破坏面小。
- **为何暂缓**：属结构性 settle 时序重排，牵动 handler catch ↔ forwardError 的 settle 边界职责划分，超出 P3「在既有转发边界并联 setter」的纯增写范围；且该路径的诊断价值可由 `outboundResponse.status`（上游真实 status）+ `entry.state==="failed"` + `failureReason` 组合还原，缺的仅是「代理层转发 status」的独立记录。非承重，先文档化待专门 settle-timing 重构一并处理。
- **若做需改什么**：选 ② 路子——① `forwardError`（`src/lib/error/forward.ts`）决定最终 HTTP status 后，若 ctx 已 settle 则调 `ctx.setClientResponseStatus(status)` + 触发 `updateEntry` 补写；② 把 `clientResponse.status` 加入 `updateEntry` 的字段 allowlist（`src/lib/context/request.ts`，参见 skill `persistence-async-invariants` §2「新顶层字段三处必改」）；③ 加测试断言非流式上游 500/429 错误路径 `entry.clientResponse.status` == 客户端实收 status（扩 `tests/history/client-response-status.it.test.ts`，独立 oracle = `res.status`）。发现方：P3 clientResponse.status 捕获 reviewer（2026-07-07），报告 `/tmp/hdm-P3-report.md` §4。

## Group-B 运营标量迁移 `_index.aux` / `model.multiplier`（P4c-3 未做，正交于 leg 重构）

- **根因**：history 数据模型重构（RFC 2026-07-07）§4 规划把 `requestBytes`/`responseBytes`/`warningMessages` 归入 `_index.aux.*`、`multiplier` 归入 `model.multiplier`（自由投影层）。但 P4c-3（删 legacy leg 写路径）**只删了 leg 字段 + `_index.derived`-已支撑的标量**（`attemptCount`/`currentStrategy`/`failureReason`），Group-B 这 4 个**列支撑/扁平运营字段原样保留**——因其迁移前置条件在 P4a–P4c-2 期间**从未搭建**。
- **当前行为**：`HistoryEntry.{requestBytes,responseBytes,multiplier,warningMessages}` 仍是顶层扁平字段。`requestBytes`/`responseBytes`/`multiplier` 由 SQL 列往返（`serialize.ts` META_KEYS → `buildHeadRow` 写列 + `deserializeEntry` 从列恢复），喂 `EntrySummary`（`in-flight.ts:toEntrySummary`）+ `ui-v4/RequestRow.tsx`；`warningMessages` 由 producer（`request.ts` `toHistoryEntry`）+ sink（`history.ts onTerminal`）写扁平字段、UI（`ui/MetaInfo.vue`、`ui-v4/MetaSegment.tsx`）直读扁平字段。`_index.aux` **全仓零 producer / 零 adapter / 零 consumer**（`grep '_index.aux'` 仅命中类型定义）。
- **理想架构**：RFC §4 目标形状——`requestBytes`/`responseBytes`/`previewText`/`warningMessages` → `_index.aux.*`；`multiplier` → `model.multiplier`（`model{}` 已由 P4c-1 填充、adapter `adaptModel` 已产 `model.multiplier`，故 multiplier 迁移比 aux 更接近就绪）。
- **为何暂缓**：删 Group-B 需**净新增架构**（填 `_index.aux`：serialize 派生的 bytes 要写进 aux；列往返改指 aux；`toEntrySummary` + `EntrySummary` 类型 + 2 个前端文件改读 aux/model.multiplier），**无任何前置阶段搭建**，且直接删会造成 UI/EntrySummary 回归（丢数据）+ golden EntryRow/列漂移。属独立工作单元而非「因范围大降级」——coordinator 决策为 option 1（prepared-only），理由已代码钉死（非偏好）。leg 重构核心不依赖这层标量 reorg。
- **若做需改什么**：① `serialize.ts` `deriveRequestBytes`/`deriveResponseBytes` 结果写进 `_index.aux.{requestBytes,responseBytes}`（或保留列 + 反序列化时投影进 aux）；② `deserializeEntry` 列往返改填 `_index.aux` / `model.multiplier`（当前填顶层扁平）；③ `buildHeadRow` `multiplier: entry.multiplier` 改读 `entry.model?.multiplier`；④ `toEntrySummary`（`in-flight.ts`）读 `_index.aux.*` / `model.multiplier` 代替扁平字段；⑤ `warningMessages`：producer/sink 写 `_index.aux.warningMessages`、UI（`MetaInfo.vue`/`MetaSegment.tsx`）改读、`updateEntry` allowlist 调整；⑥ golden `entryRowSnapshot` 列值应逐字节不变（bytes/multiplier 是列支撑、迁移只改**内存投影位置**非列内容）；⑦ 删 `HistoryEntry`/`HistoryEntryData` 的 4 个顶层扁平字段。发现方：P4c-3 删 vs 留裁决（coordinator，2026-07-07），报告 `/tmp/hdm-P4c3-report.md`。P6 backfill 或独立跟进。

## proxy-connect.ts 传输层 0% 测试覆盖（含新增 withErrorSink 应用点）

- **现状**：`src/lib/transport/proxy-connect.ts`（SOCKS5 + HTTP CONNECT 隧道原语）**整文件 0% 测试覆盖**（reviewer 2026-07-08 用 coverage 报告实测）。含 `connectViaSocks` / `connectViaHttpConnect` 的隧道握手、`fail` teardown（`socket.destroy()` 无 err + inert 语义）、CONNECT 响应解析、leftover unshift、以及本次崩溃修复新加的两处 `withErrorSink(socket)` 应用点。
- **根因 / 当前行为**：该文件建立时无配套测试（pre-existing 缺口，非本次引入）。本次 class-elimination 重构在其两个 socket 创建点加了 `withErrorSink`，模式与已测的 http2-client 站点同构、原语本身已被 `tests/transport/crash-safety.unit.test.ts` 单元测试锁死，但「proxy-connect 确实在创建点应用了 sink」这一站点级不变量无回归保护。
- **理想架构**：起一个 mock proxy 测试 harness——HTTP CONNECT 用 `net.createServer` 读 CONNECT 行 + 回 200/非 200/超时；SOCKS5 用轻量 mock 或真 `socks` server——覆盖：隧道成功握手、非 200 拒绝、超时 `fail`、握手期 socket error 不崩进程（withErrorSink 载重）、leftover-bytes unshift 正确性。
- **为何暂缓**：需搭建 SOCKS5/HTTP-CONNECT mock proxy，属独立测试基建工作单元（宽于本次崩溃修复的范围），且 withErrorSink 应用是单行、与已测站点同构、原语已单测——载重性证据充分。属「独立工作项」非「因范围大降级」，不阻塞本次交付。
- **若做需改什么**：新增 `tests/transport/proxy-connect.it.test.ts`——① HTTP CONNECT mock proxy（net server）测成功/拒绝/超时 + 断言握手期 socket 'error' 无 uncaughtException（正样本：去掉 `withErrorSink` 则红）；② SOCKS5 路径同理（mock 或真 socks server）；③ leftover unshift 用带 body 的 200 响应验证。发现方：crash-safety class-elimination 重构 reviewer（2026-07-08）。
## L1 move_blocks 翻转首块类型 → messageMapping fallback（畸形输入边界）

- **根因**：L1 de-stack 默认策略 `move_blocks`（`src/lib/anthropic/sanitize/destack-adjacent-thinking.ts`，state 默认 `thinkingDestackStrategy: "move_blocks"`）在**畸形的 thinking-not-first** assistant 轮上会重排首块：`[text, thinking, thinking]` → `[thinking, text, thinking]`（把唯一的 real separator 挪到两个 thinking 之间），使该 message 的**首块类型从 `text` 翻转为 `thinking`**。而 `buildMessageMapping`（`src/lib/anthropic/message-mapping.ts`）的 `messagesMatch` 按 role + **首块类型**匹配，首块类型对不上 → 该 message 匹配失败 → 回退到 `lastMatched`（沿用上一条已匹配的 origIdx）。
- **当前行为（已核实无害）**：**有界**——只在畸形输入上发生（thinking-not-first 本就是非法 Anthropic 结构、会被 GHC 拒；合法输入 thinking 必在首位，move_blocks 保持首块仍是 thinking，不翻转）；**优雅**——不崩溃、不抛错，两指针 walk 照常前进；**影响面仅限 history 关联索引**（rwIdx → origIdx 映射用于把改写后消息回指原始消息做 history 对账），**绝不影响送上游的 payload**（payload 是 de-stack 的正确输出，thinking 已合规去堆叠）。
- **理想架构**：三选一——① 让 de-stack 保持该 message 的首块类型不变（畸形轮也不翻转首块）；② 把默认策略切到 `insert_text`（原地插入 marker、不移动任何块，天然不翻转首块）；③ 让 `messagesMatch` 对首块重排具鲁棒性（如按多块类型集合 / id 匹配而非仅首块）。
- **为何暂缓**：畸形输入才触发 + 优雅降级 + 仅 history 索引受影响（非上游 payload）；且 `insert_text` 策略**本就完全规避此边界**（保持所有块原位），已是现成逃生舱。属「有界且无害的次级效应」，非「因范围大降级」。发现方：`feat/thinking-quarantine` 全分支终审 advisory（2026-07-07）。
- **若做需改什么**：按上「理想架构」三选一。最小侵入是把默认策略改 `insert_text`（一处 state 默认 + 复核 `insert_text` 的合成 marker 现已被 `stripAllThinking` 连带剥除，见本分支 A4 修复，无泄漏残留）；或给 `messagesMatch` 加首块重排容错 + 对应单测。

## thinking budget 与 max_tokens 冲突的行为化解决（现仅告警，未化解）

- **根因**：`adjustThinkingBudget`（`src/lib/anthropic/request-preparation.ts`）的夹取顺序是「先抬到 min → 再压到 max_thinking_budget → 最后压到 max_tokens-1」，最后一步无 re-floor。当客户端 `max_tokens` ≤ 模型 `min_thinking_budget`（如 max_tokens=1000、min=1024），结果 `budget_tokens=999 < min`——Anthropic 要求 `budget_tokens < max_tokens` **且** `budget_tokens >= min`，二者不可同时满足，是客户端自身矛盾的请求。此路径被 adaptive→enabled 合成预算（`coerceEnabledThinking` / `adaptive-thinking-rejection-retry` 默认 medium=24576）**新近更易触达**（adaptive 客户端本无理由把 max_tokens 设大）。另一相关缺口：reactive 策略恰在**元数据静默**时才触发（prepare 已弃权），故重跑时 `adjustThinkingBudget` 无 min/max 元数据，合成的 medium 预算若超过模型真实 max_thinking_budget 也**无法被夹**，会招致第二个 unhandled 400（预算过大）。
- **当前行为**：本次已加**观测告警**（`consola.warn`：max_tokens 无法容纳 min budget、budget 低于模型下限、将被上游拒），不再静默发出畸形 wire；但**未行为化解决**——仍原样发出 `budget=maxTokens-1`，上游照旧 400（只是现在可诊断）。静默元数据下合成预算超真实 max 的情形同样只会招致上游 400、无 learning 兜底。
- **理想架构**：三选一（需用户定夺，属矛盾请求的语义抉择）——① 抬 `max_tokens` 到 `min_thinking_budget+1` 让 thinking 装得下（改客户端输出上限）；② 显式**禁用 thinking**（`type:"disabled"`）让请求至少无 thinking 成功（牺牲客户端 thinking 意图，但比 opaque 400 好）；③ 新增反应式「budget-too-large」learning 策略，从上游 400 学到真实 max 后收缩预算重试（覆盖静默元数据下超 max 的情形）。
- **为何暂缓**：①②是矛盾请求的行为抉择（改 max_tokens vs 丢 thinking），无客观最优、需用户拍板，超出本次 adaptive→enabled 镜像特性范围；③是独立的新反应式策略工作单元。且现实目标场景（Claude Code haiku 子代理）`max_tokens` 通常 ≥ 数千、真实 thinking max 充裕，边界仅在 max_tokens≤1024 等病态值触达，两 reviewer 均判 LOW。属「独立工作项」非「因范围大降级」，已加告警消除**静默**面。
- **若做需改什么**：选 ②/③ 需——② `adjustThinkingBudget` 在冲突分支改写 `wire.thinking = { type: "disabled" }` + 记录 warning + 加测试（矛盾 max_tokens → thinking 被禁用而非畸形预算）；③ 新增 `budget-rejection-retry` 策略（matcher 认领「budget too large / exceeds」类 400、从错误体解析上限、收缩预算重试、注册进两个 builder、`canHandle` 与既有 thinking 策略 matcher 互斥核验）+ 单测。发现方：adaptive-thinking 镜像 subagent 双审（silent-failure-hunter R1 + typescript-reviewer LOW，2026-07-08）。

## reactive `extractErrorMessage` 嵌套-vs-顶层 message 解包鲁棒性（两个镜像策略）

- **根因**：`adaptive-thinking-rejection-retry.ts` 与 `legacy-thinking-retry.ts` 的 `extractErrorMessage` 均用 `parsed.error?.message ?? responseText` 解包。当前上游体是**顶层** `{"message":"adaptive thinking is not supported on this model"}`（非嵌套 `error.message`），靠 `responseText` 整串 fallback 命中子串，工作正常。但若未来上游体形如 `{"error":{"message":"<无关>"},"message":"adaptive thinking is..."}`，解包会优先返回**无关的**嵌套 message、跳过 responseText fallback，导致 `canHandle` 静默 false、self-heal 丢失。
- **当前行为**：对现有两种体形（顶层 message / 嵌套 error.message）都正确命中；仅对「嵌套 error.message 与顶层 message 同时存在且语义不同」的假想体形有漏判风险（当前上游不产生此形）。
- **理想架构**：解包同时兼顾顶层与嵌套——`parsed.error?.message ?? (parsed as { message?: string }).message ?? responseText`；或更稳的做法：直接对**原始 responseText** 跑 matcher 子串判定（绕过脆弱的字段优先级）。两个镜像策略应**同步改**（避免 extractErrorMessage 逻辑漂移）。
- **为何暂缓**：纯前瞻性硬化（依赖上游未来改体形），当前零触发、零成本；且改动应对称覆盖两个镜像策略、宜作一次性 extractErrorMessage 抽公共 + 双策略共用的小重构，而非单侧打补丁引入漂移。
- **若做需改什么**：抽 `extractRejectionText(error, predicate)` 公共原语（放 `src/lib/request/strategies/` 或 leaf），两策略共用；解包兼顾顶层+嵌套 message + responseText fallback；加单测覆盖三种体形（顶层 / 嵌套 / 二者共存且语义冲突）。发现方：silent-failure-hunter R3（2026-07-08）。

## 陈旧交叉引用 `state.ts:384` 指向已迁移的 `budgetToEffort`

- **根因**：本次把 `budgetToEffort` 从 `request-preparation.ts` 迁到新 leaf `src/lib/anthropic/thinking-coercion.ts`，但 `src/lib/state.ts:384` 注释仍写「见 request-preparation.ts budgetToEffort」。
- **当前行为**：注释指向失效（函数已不在该文件）；纯文档陈旧，无功能影响。
- **为何暂缓**：`state.ts` 此刻正被并发会话改动（工作区有未提交外来改动），本会话按 concurrent-sessions 纪律**不碰该文件**（pathspec 提交会连带其未提交改动，违「绝不提交他人在飞工作」）。属并发协作让路，非范围降级。
- **若做需改什么**：待 `state.ts` 并发改动落定后，把该注释指针更新为 `src/lib/anthropic/thinking-coercion.ts`。一行 doc-sync。发现方：typescript-reviewer NIT（2026-07-08）。

## 反应式学习记录 生命周期转换的遥测（negotiation lifecycle telemetry）

- **根因**：反应式学习记录（feature-negotiation 缓存）引入 TTL 生命周期后（spec `docs/spec/2026-07-08-negotiation-learning-lifecycle.md`），「自然重测环」在过期时静默丢弃 workaround、在下次上游 400 时静默重学，**无任何遥测**记录一次重测往返发生过；手动 expire / renew / pin 转换同样无信号。
- **当前行为**：生命周期转换纯静默；管理 UI 能看到当前状态与时间戳，但看不到「转换事件流」（何时过期、何时被重学、重测往返频率）。
- **理想架构**：按 richest-data-flow + telemetry-architecture，给 request-telemetry registry 加 `negotiation_lifecycle` 维度（转换类型 expired/re-learned/manual-expire/renew/pin + 分类 category + model），前端可选呈现重测频率、稳定性诊断。
- **为何暂缓**：与核心生命周期改动解耦，避免把跨切面遥测通道耦进本 spec 的数据模型 + API + UI 三块交付；属「决定数据模型后的后续项」。对抗审查 M3 提出（2026-07-08）。
- **若做需改什么**：接 request-telemetry registry（skill `telemetry-architecture`）加维度；在 `isEntryActive` 判过期→未施加的消费点、`markX` 再学点、四个 mutation 处发结构化转换事件。

## ui-v4 models-list-parity 落地的两个跟进项（2026-07-08）

来自 `docs/spec/2026-07-08-ui-v4-models-list-parity.md` 落地（分支 `feat/ui-v4-models-list-parity`）时的 not-adopted / deferred：

- **CSV 粒度 thinking 导出（not-adopted，待用户决策）**：Task 4 执行者曾把 CSV 的单 `thinking` 布尔列拆成 `adaptive_thinking` + `max_thinking_budget` 两列（信息更丰富）。**已回退**——Spec B 第 66 行明确冻结 CSV（保持与 Vue 17 列 parity），且该改动超出 Task 4 范围、未测新列形状、静默偏离 parity oracle。若用户想要更丰富的 CSV 导出，应作为**有意的独立增强**：改 spec 解冻 CSV + 加断言新 header set 的测试 + 明确接受偏离 Vue CSV parity。
- **billingRange re-clamp（Minor，spec 已声明推迟）**：Spec §2.2 提到对齐 Vue 的 watch-based re-clamp 但显式推迟到「plan 阶段」，落地只硬写了 null-init + 缺失当 0（均已兑现）。当前实务无害：目录来自稳定 react-query fetch、`billingBounds` 不会会话中途变化。若未来某次 refetch 缩小了边界而用户已选窄 `billingRange`，Radix thumb 视觉 clamp 但存储态会留越界值（仍正确过滤、可能显示为 active 但无可见效果）。若做：`ModelsPage.tsx` 的 `billingBounds` memo 处加一个 re-clamp `useEffect`。

## 并发会话预存问题（非本特性引入，2026-07-08 观察）

- **`EntrySummary.responsePreviewText` ui-v4-local tsc 错误（4 处）**：history/requests 测试 fixture（AgentLane / RequestRow / activity-row / useHistoryInfinite）在分支基点 `62ddf224`（另一会话的 `response_preview_text` 落地）已存在 ui-v4-local `tsc` 报错；根 `bun run typecheck` 与 `build:ui-v4` 均绿未捕获。非 models-list-parity 引入，属另一会话领域，未擅自修（concurrent-sessions 边界）。**提示拥有该改动的会话补 fixture 的 `responsePreviewText` 字段**（合并 master `c22aa269` 后该会话的后续 commit 可能已修，合并后须重验）。

## response_preview_text 深度 FTS `/api/search` 索引（现仅列表快筛 OR）

- **根因**：response-content-preview（spec `docs/spec/2026-07-08-response-content-preview.md` §6.2）落地时，`response_preview_text` 只接进 `read.ts` 的 `applyWhere` 列表快筛（`preview_text LIKE ? OR response_preview_text LIKE ?`），**未**进内容寻址 `search_index`（深度全文 `/history/api/search` 的 5 源 inbound/rewrites-req/rewrites-resp/req-headers/resp-headers）。spec §6.2 已显式裁决「只做列表内联快筛、不进 search_index」。
- **当前行为**：列表 `?search=` 能匹配到响应预览子串（快筛，对称请求侧 preview_text）；但专门搜索页 `/history/api/search` 无「响应内容」这一源，无法按响应内容做内容寻址去重搜索 + `contains?hash=` 反查。功能完整、仅深度搜索维度缺一源。
- **理想架构**：给 search_index 加第 6 源「response」（`req_aux` flat 文本或独立映射），backfill 一并建、`GET /history/api/search?source=response` 可选。
- **为何暂缓**：spec §6.2 已显式只做快筛（against 过度设计——响应预览是短摘要、列表 LIKE 已够用，深度 FTS 价值未证）；加源牵动 search_index schema + backfill + API + 前端源选择器，属独立搜索特性工作单元，非本 spec 范围。
- **若做需改什么**：① search_index 加 response 源（`req_aux` 或新表）；② `search-index-backfill.ts` 建该源（须 bump `search_index_version` 重建全索引，代价见 DESIGN 活的架构现状）；③ `/history/api/search` 加 `source=response` 分支 + `partial+builtPct`；④ 前端源单选器加项。发现方：response-content-preview spec §6.2 裁决（2026-07-08）。

## response-preview backfill 靶向 stage 解压（现照 search-index 全解 assembleFullEntry）

- **根因**：`response-preview-backfill.ts`（spec §6.3）实现时照 `search-index-backfill` 先例，per-row `assembleFullEntry(row, allStages)` 全解多腿（含 sse_events）再 `extractResponsePreviewText`；spec §6.3 曾提「靶向只解压 `upstream_response`（取 body）+ `client_response`（取 forwarded sseEvents）两 stage」作为优化，落地时降级为全解以避手工 stage 解码 + 旧行 legacy 适配的复杂度（plan Task 5 注记）。
- **当前行为**：回填正确但每行全量解压所有 stage blob；`extractResponsePreviewText` 只需 upstream_response.body + client_response.sseEvents 两 stage，其余（inbound_request/outbound_request/per-attempt 等）解压后即弃。大库回填 CPU/IO 有浪费（参照 `methodology-derived-column-backfill-targeted-and-nonblocking`：4.2G 库 `SELECT *` 曾卡 3m53s）。
- **理想架构**：靶向 `SELECT ... FROM entry_stages WHERE entry_id=? AND stage IN ('upstream_response','client_response')` 只解这两 stage，跳过 `assembleFullEntry` 全解，配等价性 oracle（靶向 vs 全解结果逐字节一致）。
- **为何暂缓**：正确性已达（全解是超集）；非阻塞后台 + `IS NULL` 谓词跳已建，实际回填一次性；靶向解压需手写 stage 提取 + 兼顾旧库 legacy 单 blob 形态，属性能优化工作单元，价值待大库实测确认。属「独立工作项」非「因范围大降级」。
- **若做需改什么**：① 抽只解 upstream_response/client_response 两 stage 的靶向解码 helper（兼容 legacy 单 blob 行）；② `processBatch` 改调它代替 `assembleFullEntry`；③ 等价性单测（同一行靶向 vs 全解 → 同一 `response_preview_text`）。发现方：response-content-preview spec §6.3 降级 + plan Task 5 注记（2026-07-08）。

## Responses/Gemini 详情页 Response tab 交错 text/tool wire 顺序保真（现恒 text-先-tools）

- **根因**：`accumulate-response.ts` 的 `accumulateResponses` / `accumulateGemini`（本次新补的 tool_use 抽取）组装 `MessageContent` 时恒把 text 块放最前、tools 块追加其后（`content.push({type:"text"}); for(tools) content.push({type:"tool_use"})`），**不保留**上游 wire 里 text 与 tool 的真实交错顺序。Anthropic（`accumulateAnthropic` 按 index 定位）与 CC（`accumulateOpenAICC` 按 tool_calls 数组）无此问题。
- **当前行为**：**净新增能力、非回归**——这两端点流式工具此前在详情页 Response tab 根本不显示（既有盲区），本次补抽取后可见，只是多工具与文本交错时顺序被规整为 text-先-tools。响应预览列摘要（工具优先 `[A,B] text`）本就工具先、不受影响；仅详情页 Response tab 的块渲染顺序与真实 wire 可能不同。
- **理想架构**：`accumulateResponses` 按 `output_index` / `accumulateGemini` 按 part 出现序把 text 与 tool_use 块**按真实交错序**入 `content[]`（类似 `accumulateAnthropic` 的 index 定位），保 wire 顺序保真。
- **为何暂缓**：本次目标是「让这两端点流式工具在预览列 + 详情页可见」（此前完全不可见），已达；交错顺序保真是保真度增量、对预览列零影响、对详情页仅影响多工具+文本混排的罕见块序；且需给两累加器加序号定位逻辑。属「保真度优化独立工作项」非「因范围大降级」。
- **若做需改什么**：① `accumulateResponses` 用 `Map<outputIndex, block>` 保 text/tool 混合序（text delta 也按 output_index 归位）→ 按 index 排序出 content；② `accumulateGemini` 按 parts 遍历序交替 push text/tool_use（不再分离两桶）；③ 交错序单测（text→tool→text → 三块保序）。发现方：response-content-preview spec §4 H1 扩展的保真度残余（2026-07-08）。

## ui-v4 raw-json-dual-view 落地的 minor 跟进项（2026-07-08）

来自 `docs/spec/2026-07-08-ui-v4-raw-json-dual-view.md` 落地（分支 `feat/ui-v4-raw-json-dual-view`）的 review minor（均非阻塞，已 landed）：

- **JsonTreeView copy-path 对含 `.`/空格的 object key 非 round-trip**：`{"a.b":1}` 的 copy-path 产出 `$.a.b`（看似嵌套）。copy-path 是便利功能非正确性契约、内部工具可接受。若做：对不匹配 identifier 正则的 key 用 bracket-quote（`$["a.b"]`）。
- **RawJsonView 可选 `label` 位于 `role="tablist"` 内**：WAI-ARIA tablist 直接子元素应仅为 `role="tab"`。若做：把 label `<span>` 移出 tablist 容器。另：完整 tabs 键盘方向键导航 + roving tabIndex 未实现（原生 `<button>` 可点击可聚焦，功能可用）。
- **ResponseSegment ForwardedBody `content` 静态类型 `unknown`**：当前经 producer 契约（`ForwardedResponse.content` = 端点响应对象）保证是结构化 JSON、喂 RawJsonView 安全；与迁移前 `JSON.stringify(content)` 行为一致。若未来某端点转发裸字符串非流式 body，tree 视图会显单个带引号 primitive。若做：加 `typeof content === "object" ? RawJsonView : RawPre` 守卫与其它站点对称。

## `disabled_models` 实际只在 Anthropic 路径拦截，CC/Gemini/Responses 放行（可用性语义不一致）

- **现状（2026-07-08 对抗审查实测，spec `docs/spec/2026-07-08-models-drawer-and-disabled-visibility.md` HIGH-1）**：`config.disabled_models` 经 `applyDisabledFilter`（[state.ts:996](../../src/lib/state.ts#L996)）把模型从 `state.models`/`state.modelIndex` 滤除，其**自述职责是「从列表隐藏 / 压制废弃项」**（[state.ts:461-468](../../src/lib/state.ts) 注释），**不是全局可用性拦截**。实测请求路径：
  - **Anthropic `/v1/messages`**：`supportsDirectAnthropicApi(id)`（[features.ts:38](../../src/lib/anthropic/features.ts#L38)）→ `modelIndex.get` 返 undefined → vendor≠Anthropic → **reject 400**。此路径拦截成立。
  - **OpenAI CC / Gemini / Responses**：`isEndpointSupported(undefined, …)`（[endpoint.ts:47](../../src/lib/models/endpoint.ts#L47)）对不在 index 的模型**返回 true**（legacy fallback）→ passthrough → 用禁用模型准确 id **直发上游、能成功使用**（三 codec：[openai-cc/codec.ts:354](../../src/lib/codec/openai-cc/codec.ts)、[openai-gemini/codec.ts:158](../../src/lib/codec/openai-gemini/codec.ts)、[openai-responses/codec.ts:381](../../src/lib/codec/openai-responses/codec.ts)）。
- **为何记录**：模型抽屉可见性 spec 把 config-disabled 模型暴露到 UI 可见 + 可深链复制 id；结合上述，用户从抽屉拿到禁用 id 即可经 CC/Gemini/Responses 使用。对**内部个人工具**（internal-tool-security-posture ADR：全量暴露、运维价值 > 假想泄露）这本身不是缺陷；但「disabled 在 4 条路径里 3 条不 disable」是**语义不一致**，值得用户决定是否统一。
- **若做（把 disabled 变成真正的可用性拦截）**：在三条 OpenAI 系 codec 的 route 决策里，对「解析出的 name 命中 disabledSet」显式 reject（而非依赖 `modelIndex.get` + permissive `isEndpointSupported(undefined)`）；或收紧 `isEndpointSupported(undefined)` 的 permissive 默认（风险：会连带影响真正的 legacy 未知模型 passthrough）。需一组四路径的拒绝/放行回归测试。发现方：spec 对抗审查 subagent（2026-07-08）。

## ui-v4 模型详情抽屉移动端/窄屏响应式

- **现状**：模型详情模态抽屉（spec `docs/spec/2026-07-08-models-drawer-and-disabled-visibility.md`）默认 60vw、min 320px；窄屏（< ~640px）下 320px 抽屉 + 遮罩仍会挤压，未做「窄屏全宽」响应式。
- **暂缓原因**：用户明确「移动端响应式未来用户要求了再做」（2026-07-08）。本项目主要是桌面端内部工具。
- **若做**：抽屉 `Dialog.Content` 宽度加断点——`< sm` 时 `w-full`（占满、min 让位）、`>= sm` 时用 resizable 60vw；或用 CSS `min(60vw, 100vw)` 之类。属独立 UX 增强。

# 暂缓 backlog（从记忆库归位）

从记忆库降为引用层（2026-07-05）时归位的活 backlog。每条：现状 / 暂缓原因 / 若做需改什么。

## Console footer 宽度感知落地的跟进项（2026-07-10）

- **背景**：footer 行宽感知 + 按模型分组已落地（`docs/plan/2026-07-10-tui-footer-width-aware-grouping.md`）。以下四项经计划评审明确推迟（footer-only 瞬时损失、完成态 log line 补回，可接受），非本次范围：
  - **`renderFeatureTag` detail 富化**：`tool-input-decode-failed` / `context-edits-applied`（带 `{count,clearedInputTokens,types}`）/ `protect-streaming-retry`（带 `{outcome,retries}`）/ `tool-input-repaired` 等 8 个 recovery/repair case 当前只渲染裸标签名，未展开各自 `detail`。若做：在 `console.ts` 的 `renderFeatureTag` 对应 case 里读 detail 拼富标签（如 `context-edits:3`），加对应单测。
  - **单请求 footer 富化**：count===1 分支仍只显 method/path/model/elapsed/stream，未显已应用 tags/thinking/attempt 次数（有富数据但末端未呈现）。若做：在 count===1 分支追加 tag 摘要，仍经 `finalizeFooter` 截断。
  - **外部直写 stdout 撞 footer**：任何绕过 `printLog` 的 `console.log` 会撞坏 footer 协调。当前 republish 已收编 consola，残余风险低。若做：需一个全局 stdout 写入拦截层。
  - **`(resolving)` 桶丢 path**：未解析模型的请求在分组里归 `(resolving) ×N`，丢了各自 path（现状逐条显示会带 path）。footer-only 瞬时损失，完成态 log line 补回。若做：`(resolving)` 桶特殊化为逐条显示 method+path。

## 分组 footer 自适应显示最久的 N 个请求时间（用户 2026-07-10 要求，待 P0 后做）

- **背景/动机**：现状多请求分组 footer 每组只显**单个** `maxElapsed`（最老请求）。用户要求：根据组数自适应显示每组**最久的几个**请求时间。
- **规格（已与用户敲定 + 默认补全）**：每组显示条数 = f(组数)——**1 组→最久 5 个 · 2 组→每组最久 3 个 · 3 组→每组最久 1 个 · 4+ 组→每组最久 1 个**（横向空间紧，默认，仍受 `columns-1` 宽度截断兜底）。组内「最久的 N 个」= 组内请求按 elapsed 降序取前 N 的 elapsed。段形如 `claude-opus-4-8 ×5 ↓12KB 9.1s 7.3s 5.0s 3.2s 1.1s`。
- **为何待 P0 后**：这是**行为变更**，而 P0 是行为逐字等价的纯重组（golden-fixture 锁 footer 输出）；现在改会污染等价 oracle。P0 落地后作独立 feat，只碰 `tui/render/footer.ts`（重组后 footer 的家）+ 测试 + 一次**有意的** golden 更新。
- **若做需改什么**：`buildActiveFooter`/`buildModelGroupSegments`（重组后在 `tui/render/footer.ts`）——组内保留 top-N elapsed（现只留 oldest）；段构建按 f(组数) 取 N 个 elapsed 拼接；宽度驱动纳入循环的 segment 宽度估算随之变长（`stringWidth` 仍兜底）；golden-fixture 场景须体现多组多时间；补单测覆盖 1/2/3/4 组各自的 N。

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

## negotiation lifecycle 交付评审滚存的两处 sharp edge（2026-07-08）

来自 `feat/negotiation-lifecycle` 分支交付审计（code-reviewer + typescript-reviewer + react-reviewer）flag 的两处非阻塞待复访项：

- **flat-category 快照 `value` 是 endpoint 级 modelKey 而非裸模型**：`systemRejectModels` / `serverToolDowngrade` 分类的 `LearnedEntryView.value` 形如 `https://…|anthropic-messages|<model>`（endpoint 级 modelKey），非裸模型名。**当前行为**：前端 `ui-v4/src/lib/learned.ts` 的 `displayValue` 检测 `|anthropic-messages|` 标记并美化为裸模型名展示，功能完整；但后端快照的裸真值只能靠前端字符串切割还原。**若做**：后端 `viewOf` 给这两分类的 `LearnedEntryView.detail` 携带结构化裸模型名（`detail` 字段已存在），前端读 `detail` 而非切 `value`，更干净、少一处前端解析脆弱点。
- **`negotiation_learning.ttl_days` 整表替换语义易踩**：`config.ts` 把 `ttl_days` 整表替换进 `negotiationTtlOverridesMs`（whole-map replace，非 per-key merge），而默认覆盖含 `partnerFeatures: never`（`Number.POSITIVE_INFINITY`）。**当前行为**：用户设任一 `ttl_days`（如只想改 `toolFields`）而不重列 `partnerFeatures`，会把 `partnerFeatures` 从默认的 `never` 静默打回 `default_ttl_days`（30d）——即 partner-feature 学习记录开始 30d 后过期，非预期。DESIGN 活的架构现状 + 运行时选项表已注记此陷阱。**若做**：在 `config.yaml` / `config.example.yaml` 加一段带注释的 `negotiation_learning` 配置样例，显式演示「改单个分类须重列所有想保留的覆盖（含 `partnerFeatures: 0`=never）」，把陷阱前置到配置发现层。发现方：negotiation-lifecycle 交付审计（2026-07-08）。

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

## LiveDock 在途浮窗:per-group 折叠(现整面板一档折叠)

- **根因**：`LiveDock` 展开面板按 resolved model 分组渲染,但整个面板只有一档「折叠/展开」(`livedock.expanded`),组头(`LiveGroup` `showHeader`)不可单独折叠。spec §2 已显式把 per-group 折叠列为推迟项。
- **当前行为**：展开时所有组全部铺开;在途请求数少时(典型 1-数条)无碍,组数多、单组行数多时面板变长需内滚。
- **理想架构**:`LiveGroup` 加 per-group 折叠态(组头点击折叠该组明细),折叠态持久化(如 `livedock.collapsedGroups`)。
- **为何暂缓**:小 N 价值低(spec §6 已加 `groups.length>1` 才显组头 + N=1 扁平退化);属体验增量,非阻塞。
- **若做需改什么**:① `LiveGroup` 加 `collapsed` prop + 组头 toggle;② `LiveDock` 维护 per-group 折叠 Set + localStorage;③ 折叠态单测。发现方:live-inflight-dock spec §2(2026-07-08)。

## LiveDock:请求终态淡出动画(现瞬时移除)

- **根因**:`applyActiveEvent` 对 completed/failed/aborted 直接从 `byId` 删除(`live-store.ts`),UI 行随即消失,无过渡。spec §2 列为推迟项。
- **当前行为**:高频完成时行会突兀消失/面板重排(final review I-1 邻域观察),功能正确仅体验略生硬。
- **理想架构**:终态行标记 `settling` 保留短暂(如 300ms)播放淡出后再移除,或用 CSS transition + React 退场(如 framer-motion / 手写 timeout)。
- **为何暂缓**:纯体验项;引入退场态会让 reducer/渲染复杂化(需区分「活跃」与「正在退场」),价值未证。
- **若做需改什么**:① reducer 终态转 `settling` 而非删除 + 延时清理(注意 never-throw/drain);② `LiveDetailRow` 退场动画;③ 时序单测(fake timers)。发现方:live-inflight-dock spec §2 + final review(2026-07-08)。

## LiveDock:面板内直接 abort 在途请求(现仅跳详情页)

- **根因**:`LiveDetailRow` 点击 `onSelect(id)` → `navigate(/requests/:id)`,abort 操作留在详情页;面板内无 abort 钮。spec §2 列为推迟项。
- **当前行为**:要中止在途请求须先进详情页;面板是只读监视器。
- **理想架构**:明细行加 abort 按钮 → 调用现有 abort 端点(详情页所用同一 API),乐观从 `byId` 移除或等 `aborted` 事件。
- **为何暂缓**:超出「把在途信息可视化」的本次范围;abort 是写操作,需确认交互 + 错误处理,属独立功能单元。
- **若做需改什么**:① 明细行 abort 钮 + 确认;② 复用详情页 abort API 调用;③ 乐观更新 / 依赖 `aborted` WS 事件回收;④ 交互单测。发现方:live-inflight-dock spec §2(2026-07-08)。

## LiveDock:展开态键盘焦点行被叠加层遮挡时自动滚入(现仅 Escape 缓解)

- **根因**:展开面板 `absolute bottom-6 max-h-[55%]` 叠加在 History 底部;若 HistoryList 键盘 roving 焦点行(`HistoryList.tsx` ArrowDown `align:"end"`)滚到被面板遮住的区域,会「有 DOM 焦点但视觉不可见」。Virtuoso 对 overlay 无感知。spec §2/§6 列为已知限制。
- **当前行为**:焦点可能落在面板背后;本次以 Escape 收面板缓解,不自动滚入。
- **理想架构**:展开态下把 History 可视区下界收缩到面板顶(paddingBottom 或 scrollIntoView 计算避让),使焦点行始终滚入未遮区。
- **为何暂缓**:边缘可访问性场景;需让 History 感知 overlay 高度(跨组件耦合),价值/频次低。
- **若做需改什么**:① LiveDock 暴露展开高度;② HistoryList 据此调 Virtuoso 视口/scrollToIndex 避让;③ 焦点可见性核验(浏览器)。发现方:live-inflight-dock spec §2/§6 + final review(2026-07-08)。

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

## ~~retreated（OOM cap）+ empty_text 锚点 → index 碰撞 + 双 message_start~~（已修复 2026-07-11，block-level-buffered-retry P1 Task 7）

> **已关闭**：默认 `on` 翻转（spec `2026-07-11-block-level-buffered-retry` §6.3）把此罕见残留放大，故本 spec P1 一并修复（不再「罕见不修」）。修法即下方「理想架构」：retreat 分支复用 `flushBufferedFrames`（一次性 anchor close-off `stop@0` → H1 message_start dedup → +1 remap），后续 live-write 帧统一施加同一 remap + dedup（`driver.ts:639-648` 的 retreat live 分支 + `:655-680` 的 retreat flush）。retreat flush 用 `suspendHeartbeat`/`resumeHeartbeat`（可恢复）而非终末 permanent freeze——retreat 后仍有 live 流、须保活。M1 post-retreat close-off 经共享 `anchorClosed` 幂等（retreat flush 已关则短路，无双 `stop@0`）。测试 `tests/pipeline/retreat-anchor-collision.test.ts`（retreated-complete + retreated-stream-error + no-anchor 中性三例；注入 bug 证 FAIL：raw flush → 双 message_start + @0 碰撞、live-write raw → 块跨 @0/@1 撕裂）。


- **根因**：`runResponseBufferedSink` 的 retreat 路径（buffer 超 `protectStreamingBufferCapBytes` 默认 16MiB → 放弃缓冲、转 live 写透，driver.ts:601-620）**不做 +1 index remap、不 dedup message_start**——这两个变换只在 commit 成功分支（Task 3.3）做。但 empty_text 锚点（Task 3.2/3.3）一旦经心跳注入，就占了客户端 index 0 且已转发一次 message_start。
- **当前行为**：若「先 idle-stall >20s 触发锚点注入 → 之后上游爆发 >16MB 触发 retreat」这一罕见复合条件命中，retreat 的 flush + live write-through 会：① 真实 `content_block_start@0` 与锚点 @0 **index 碰撞**；② buffer 里已转发的 message_start **被重发**（双 message_start）。两者皆客户端可见协议违规。retreated-complete 与 retreated-stream-error 两子路径都有。Task 3.4 的 `closeAnchorIfOpen` 只补一个 stop@0、无法挽回已 live 发出的真实帧。
- **理想架构**：retreat 路径在 `anchorState.injected` 时对 retreat-flush 帧与后续 live-write 帧统一施加 `anchor.remap(frame, 1)` + `messageStartForwarded && isMessageStart → skip`（镜像 commit 分支 driver.ts:662-668 的变换）。
- **为何暂缓（2026-07-09：罕见残留、不修）**：retreat 触发需 `bufferedBytes > 16MiB`（driver.ts:622 计 `frame.data.length + frame.event.length`），上游对 Anthropic 路径硬上限 `max_output_tokens: 64000` + `max_thinking_budget: 32000`（refs/AVAILABLE_MODELS.json），典型响应帧字节远低于 16MiB。**但不可达估算不硬**（plan review N4）：细粒度小 delta 的逐帧 framing 开销 + thinking signature 可把帧字节推高，pathological 下逼近 16MiB 非绝无可能。故定位为**罕见残留协议违规**（非「证明不可达」），叠加「先注锚点」后更罕见——用户 2026-07-09 明确不做。keepalive-timeout-safety 特性的 live 对账 gate 在 `buffered===false`、结构上够不到 retreat（在 buffered 内），故不会误碰。若未来实测确证可达需修：改 driver retreat 分支复用 commit 分支 remap+dedup 读共享 anchorState。锚点特性主路径（commit + 终末失败）正确性已实证。
- **若做需改什么**：`src/lib/pipeline/driver.ts` 的 retreat 分支（:601-620 附近）——注入锚点时对 live 路径帧施加与 commit flush 同一的 remap+1 + message_start dedup；补一条 retreated+anchor 的单元测试（buffer 超 cap + 锚点已注入 → 断言真实块 @1 无碰撞、message_start 恰 1 次）。执行期发现（Task 3.4，2026-07-08）。

## 上游 h2 PING 保活的 unacked-ping 死连接快速 teardown（liveness 探测）

- **背景（2026-07-09 落地）**：为对抗「GHC 长思考静默期连接被空闲回收、上游流无 `message_stop` 截断」，加了上游 HTTP/2 PING 周期保活（`timeouts.upstream_h2_ping` 默认 15s，`transport/http2-client.ts:scheduleH2KeepalivePing`）。v1 是**纯保活**：`session.ping()` 的 ack 回调忽略（`NOOP_PING_ACK`）。
- **现状**：连接真死时，靠 node:http2 session 的 `error`/`close`/`goaway` 事件落 `drop`（清 timer + 移出池）+ 让在途请求失败——但这依赖底层 socket/session 自己察觉死亡（可能拖到它自己的 idle timeout 才 emit）。PING 的 ack **没被用来主动判活**。
- **理想架构**：记录每次 PING 的发出时刻，若连续 N 个 PING 在 `ackTimeoutMs`（如 2×interval）内无 ack，判定连接已死 → 主动 `session.destroy()`，把「静默挂死」转成**及时的可重试错误**（配合 L2 缓冲重试快速换新连接）。这是把 PING 从「保活」升级为「保活 + liveness 探测」。
- **为何暂缓**：本次修复目标是**阻止**空闲回收（放真帧上 wire），已由纯保活达成；unacked-ping 的死连接快速 teardown 是**正交的另一个关注点**（加速失败恢复，非阻止截断），且引入「慢但活的连接被误判 teardown」的假阳性风险，需实测标定 `ackTimeoutMs`。against-yagni 的反面不适用——它不是本 bug 的必需件，是独立增强。
- **若做需改什么**：`scheduleH2KeepalivePing` 的 ack 回调改为记 in-flight ping 计数/时刻 + 一个 `ackTimeoutMs` 守卫（连续无 ack → `session.destroy(new Error("h2 keepalive ping unacked — dead connection"))`）；加 config 旋钮 `timeouts.upstream_h2_ping_ack_timeout`；夹具用 Node http2 server（Bun server 的 ping ack 行为不忠实，见 skill `bun-upstream-transport`）跑一个「server 停 ack → 客户端在 timeout 内 destroy」的集成测试。发现方：本特性落地设计取舍（2026-07-09）。

## 上游主动发帧手段盘点（END_STREAM 后无流级保活杠杆）+ h2 PING 运行时可观测性

- **背景（2026-07-10 排查 `req_1783704300404_484` 引出）**：一条 anthropic-messages 请求上游静默 ~169s 后爆发部分 `tool_use` 即被截断（无 `message_stop`），追问「h2 PING 有没有生效 / 有没有记录 / 还有什么主动发帧手段」。前两问结论：PING 按默认配置启用（`upstream_h2_ping: 15`），但运行时对 ping 的发送/ack **零可观测**（`NOOP_PING_ACK` 丢弃 ack，无 log/计数/telemetry；history record 是 single-request 视角、结构上不含 connection-level 的 ping 痕迹）。可观测性修法已并入上一条「unacked-ping teardown」的「记录每次 PING 发出时刻」——**不重复**，那条落地时顺带补 per-session `sent/acked` 计数即可让「ping 生效吗」可从 telemetry 回答。
- **现状（实测枚举，2026-07-10 node v24 探针）**：我方请求流是 `req.write(body); req.end()`（`http2-client.ts:489-490`），`req.end()` 后 `writableEnded=true`（END_STREAM 已发、写端半关闭）。此后客户端**仍能主动上 wire 的帧**只有：

  | 帧 / API | 作用域 | 能否刷新单条流的应用层 idle | 备注 |
  |---|---|---|---|
  | `session.ping(payload, cb)` PING | 连接级 | ✗（连接级） | 已用；唯一带 ack 回调可测 RTT/liveness |
  | `session.settings()` SETTINGS | 连接级 | ✗ | 非保活语义 |
  | `session.setLocalWindowSize()` → WINDOW_UPDATE | 连接级 | ✗ | 流级 WINDOW_UPDATE 仅在有 DATA 可 ack 时随消费自动发；静默期无帧可发 |
  | `req.priority()` PRIORITY | **流级** | ✗（多数服务端忽略） | RFC 9113 已废弃 stream priority，唯一 references 本流的客户端帧、但收益存疑 |
  | `req.sendTrailers()` | 流级 | — | 仅 END_STREAM **前**有效，`req.end()` 后已太晚 |

- **结论（承重）**：HTTP/2 协议**不提供半关闭流的流级 keepalive**——所有可主动发的帧要么连接级（刷新的是整条 h2 连接的 idle，防中间盒/连接回收，已由 PING 覆盖），要么是已废弃/被忽略的 PRIORITY。故若掐断方是 **GHC 对单条 stream 的应用层超时**，我方**没有任何新的主动发帧杠杆**能阻止它（case B）；预防层到 PING 为止，恢复层只能靠 **L2 缓冲重试**（`protect_streaming_generation`，默认 OFF）。WebSocket 路径同构：`client.ping()`（Bun-only）也是连接/预防级、不重置帧-idle guard，PoC 已判不落地（见下方 R5.1 条）。
- **为何暂缓**：这是一次**盘点/定性**而非缺陷——现有 PING 预防层 + buffered-retry 恢复层已是协议允许范围内的完整应对，不存在「漏掉的主动手段」可补。记录它是为了封存「能不能给单条流保活」这个反复会被重新提起的问题（答案：协议层面不能），避免后续 speculative 地去实现 PRIORITY-poke 之类无收益改动。
- **若做需改什么**：无需实现主动发帧新杠杆。唯一有收益的动作是把 PING 从 fire-and-forget 升级为**观测 + 判活**——完全落在上一条 unacked-ping teardown 的范围内（那条的 ack 记账即同时补齐本条的可观测性）。若未来实测发现 GHC 对连接级 PING 有响应式续期收益，可再评估缩短 `upstream_h2_ping`；PRIORITY-poke 明确**不做**（废弃帧、收益存疑）。发现方：`req_484` 截断排查（2026-07-10）。

## POST-COMMIT 失败的 error 帧 + 锚点收口帧不进 history clientResponse.sseEvents

- **现状（2026-07-09 Phase 5 审查实证）**：delayed-commit 的 catch 块在 `setForwardedResponse({sseEvents:[...forwardedSseEvents]})` 快照**之后**才写 error 帧（`writeSynthetic`）——`git show` 父提交确认这是**既有** pattern（error 帧本就在快照后写、早已不进 history 轨）。这违反 `client-sink.ts:24-29` 明文契约（handler 应按 `writeSynthetic → recordForwarded → settle` 顺序，即先写 error 帧再快照）。
- **本特性拓宽**：keepalive timeout-safety 的 Phase 5 终末收口新增的 `content_block_stop@0`（`closeAnchorIfOpen`→`writeAnchor`）同样落在快照之后 → 不进 `clientResponse.sseEvents`。wire 协议完整（客户端真收到收口帧 + error 帧、无残留 open 块，已测），仅 **history 轨**这一正交维度不完整。
- **理想架构（richest-data-flow）**：catch 块重排为 `closeAnchorIfOpen → writeSynthetic(errorFrame) → setForwardedResponse(snapshot) → ctx.fail`——与 client-sink 已文档化契约一致，一并闭合既有 error-帧缺口 + 新 stop@0。四个 POST-COMMIT 失败分支（reaper/timeout、HTTPError、unknown、reject）统一。
- **为何暂缓**：正确修法触及 4 个分支的既有 settle-ordering（`ctx.fail` 同步冻结 `clientResponse`，重排须守 persistence-async-invariants），与 keepalive 保活特性正交、宜合并成聚焦跟进（与本 backlog 同族的 settle-ordering 项一并处理）；本特性的 wire 协议完整性不受影响。发现方：Phase 5 交付审查 subagent（2026-07-09）。
- **若做需改什么**：`src/routes/messages/handler-v4.ts` delayed-commit catch 块四分支重排 close→writeSynthetic→setForwardedResponse→fail；补一条断言「注锚点后 POST-COMMIT 失败 → history `clientResponse.sseEvents` 含 error 帧 + stop@0」的测试（现测试断言在 wire `res.text()`，须加 history 轨断言）。参 skill `persistence-async-invariants`。

## 上游 WebSocket 应用层保活（Bun-only ping / TCP keepalive）—— PoC 判不落地（R5.1）

- **PoC 结论（2026-07-09，`exp/ws-upstream-keepalive/`）**：`import { WebSocket } from "undici"` 解析到的实现**取决于运行时**——**Bun**（`dev`/`start` 主运行时）恒等于原生 `globalThis.WebSocket`，带 `ping()`/`pong()`/`terminate()`，实测 `client.ping()` 能把真 WS PING 控制帧发上 loopback wire；**Node**（发布 npm CLI `dist/main.mjs`）是真 undici 7.28.0 WHATWG 实现，**无 `ping()`**、无 socket 访问器。故计划原假设“undici WS 无 ping()”只对 Node 成立。
- **现状（当前行为）**：`upstream-ws-connection.ts` 不做任何上游 WS 应用层保活。h2 路径有双层（`socket.setKeepAlive` + `scheduleH2KeepalivePing`），WS 路径**零保活层**。`ss -tnope` 实测：Bun 客户端 WS 的 upgrade socket 默认**不带** `timer:(keepalive,...)`（h2 socket 有）。
- **根因**：WHATWG WebSocket 面不暴露底层 socket，无法 `socket.setKeepAlive()`；且 Bun 的 `undici` shim 用原生实现、忽略 `WebSocketInit.dispatcher`，故 Node undici 那条“自定义 dispatcher 里设 keepalive”的理论路径在 Bun 上也不通。
- **为何暂缓（不落地 speculative code）**：即便 Bun 的 `.ping()` 可用，WS PING 是**控制帧**、不产生 `ResponsesStreamEvent`，**不重置** `state.streamIdleTimeout` 帧-idle guard（与 h2 PING 同构）——它至多是一层**预防**（防 middlebox/GHC edge 收割空闲连接），**不是恢复**、也不救 > 300s 合法静默。且（a）运行时不对称（Node CLI 无此能力，落地会造成两运行时行为分裂）、（b）真实 GHC 收益**未证**（不像 h2 PING 有过 112s 静默无 `message_stop` 的实测收割观测）。承重恢复防线是 **Phase 3 的 buffered 重试**（spec R5.1；对 WS ≥ 对 h2 关键，因 WS 无有效预防层）。
- **若做需改什么**：① 若要 Bun-only app-level WS ping —— 在 `createUpstreamWsConnection` 加一个 `typeof socket.ping === "function"` 守卫下的周期 `socket.ping()`（类比 `scheduleH2KeepalivePing`，`unref` timer、busy/OPEN 门控），config 键复用或新增 `timeouts.upstream_ws_ping`；**前置门控**：先对真实 GHC 上游做长静默保活对照实验证明确有收益（当前无观测数据），否则是无收益的运行时分裂。② 若未来换 WS 库（如 `ws` 包，暴露 `_socket` 可 `setKeepAlive` + 有 `ping()`）或 Node undici 开放 dispatcher-level keepalive 且 Bun 跟进 —— 可统一两运行时的 TCP keepalive。③ 无论哪条，都**不代偿** > 300s 的帧-idle guard（那需调大 `streamIdleTimeout`，见 R5.3）。发现方：Task 4.1 PoC（2026-07-09）。权威结论见 `exp/ws-upstream-keepalive/REPORT.md`。

## 下游 Responses WS（`ws.ts`）未采用 buffered 重试（现仅 SSE 采用）

- **根因**：Codex/Responses tier-1 硬化（spec `2026-07-09-codex-responses-tier1-hardening` R4-mid）只把下游 **SSE**（`routes/responses/handler-v4.ts`）接进 driver 的 opt-in `runResponseBufferedSink`（第二消费者）；下游 **WS-to-client**（`routes/responses/ws.ts:359`）仍恒走非缓冲 `runResponseSink`——WS 路径的 buffered 采用未纳入本特性范围（spec §6 Phase 3 列为 Phase 3 范围外）。
- **当前行为（已核实无害）**：下游 WS 路径 mid-stream 上游掉线→fail + 保留 partial + 截断 error 帧（live 语义，即今行为不变），**无 mid-stream 透明重试**。WS 已有下游保活（`responsesKeepaliveFrame`，ws.ts:305-315）+ 崩溃防护 + 上游关闭码修复，仅缺 buffered 重试这一层。功能完整、仅比 SSE 路径少一层可选恢复能力。
- **理想架构**：`handleResponseCreateV4`（ws.ts）比照 SSE handler 经 `resolveResponsesBufferedAndHeartbeat` 选路：`responsesBufferedRetry` on 时选 `runResponseBufferedSink`（同 opts：`sawMessageStop`/`sawUpstreamError`/`anchor:undefined`/caps）、off 走现 `runResponseSink`。注意 WS 的终态早停（`stopAfterFrame: isTerminal`）+ `sendErrorAndClose`+1011 错误路径与 buffered 的 commit/flush 时序需对齐。
- **为何暂缓**：SSE 是 Codex tier-1 主传输（根因记录 `transport: http`），WS-to-client 是次要路径；buffered 采用需核 WS 的 close-code/1011 错误路径与 buffered commit 时序交互（比 SSE 复杂），属独立工作单元；且 buffered 默认 OFF，缺省无差异。属「独立工作项」非「因范围大降级」。
- **若做需改什么**：① `ws.ts` `handleResponseCreateV4` 加 `resolveResponsesBufferedAndHeartbeat` 选路（复用 `buffered-config.ts`）；② buffered 分支的 `makeWsSink` heartbeat 强制注入对齐 SSE；③ 核 WS 终态早停 + `sendErrorAndClose`+1011 与 buffered commit/retreat 的时序；④ mid-stream WS drop（buffered）触发重试的回归测试。发现方：spec §6 Phase 3 范围界定 + Task 5.1 doc-sync（2026-07-09）。

## Responses buffered 无专属 caps（现复用 Anthropic `protectStreaming*`）

- **根因**：Responses buffered 重试（`responsesBufferedRetry`）的 `retryCap`/`bufferCapBytes`/强制 heartbeat 兜底**复用** Anthropic 的 `protectStreamingMaxRetries`（3）/`protectStreamingBufferCapBytes`（16MiB）/`protectStreamingHeartbeat`（`handler-v4.ts:379-380` + `buffered-config.ts`）。Responses 只有独立的**门控**键 `responsesBufferedRetry`（默认 OFF），无独立的 cap 键。spec R4.2 已注「caps 需 Responses 侧对等 config（对齐命名）」但落地时复用 Anthropic 键。
- **当前行为（已核实无害）**：两端点共享同一组 cap 数值——调 `protect_streaming_max_retries` 会同时影响 Anthropic + Responses 的 buffered 重试上限；调 `protect_streaming_buffer_cap_bytes` 同理。功能完整（数值合理、两端点场景相近），仅缺「按端点独立调参」的能力 + 命名上 Responses 路径读的是 `protectStreaming*`（Anthropic 命名空间）略有认知负担。
- **理想架构**：给 Responses 引入对等 cap 键（`openai_responses.buffered_retry_max_retries`/`buffered_retry_buffer_cap_bytes`/`buffered_retry_heartbeat`，或统一到一个跨端点 `streaming_buffered.*` section），`resolveResponsesBufferedAndHeartbeat` 读 Responses 键、fallback 到共享默认；Anthropic 保持 `protectStreaming*` 或一并迁到共享 section。
- **为何暂缓**：默认值对两端点均合理、buffered 默认 OFF，独立调参需求未证；引入 3 个新 config 键属 config-schema 扩展工作单元（5 触点注册 + 文档），价值待实证按端点调参需求。属「独立工作项」非「因范围大降级」。
- **若做需改什么**：① `state.ts` 加 Responses 对等 cap 键（5 触点：类型/CONFIG_MANAGED_DEFAULTS/schema.strict/两处 assign，参照 `responsesBufferedRetry` 注册）；② `buffered-config.ts` + `handler-v4.ts:379-380` 改读 Responses 键（fallback 共享默认）；③ `config.example.yaml` 补注释样例；④ DESIGN 运行时选项表 + 「活的架构现状」Codex/Responses 行更新。发现方：spec R4.2 caps 命名注记 + Task 5.1 doc-sync（2026-07-09）。

## chat-completions + Gemini 下游 SSE 无 heartbeat（长静默 idle 风险，现仅 Anthropic/Responses 有保活）

- **根因**：下游客户端保活（forward-idle heartbeat）目前只接在 Anthropic（`stream_keepalive_*` / delayed-commit）+ Responses（`responsesKeepaliveFrame`，本特性 Task 2.1）两条 SSE 路径。**chat-completions**（`routes/chat-completions/handler-v4.ts:327-329` 注释明写 "No heartbeat (CC has no stream_keepalive_ping_sec)"）+ **Gemini**（`routes/gemini/handler-v4.ts:271` "Gemini has no `[DONE]` / no heartbeat"）的 `makeSseSink` 都**不传 heartbeat**，故长上游静默期不注入保活帧。
- **当前行为（已核实无害）**：CC/Gemini 客户端若有 ~300s-idle 超时（如某些 SDK 默认），遇到长 reasoning 静默的上游会 idle 断连（与 Responses 修复前同类问题）。当前无已知 CC/Gemini 消费者命中此边界（多数 CC/Gemini 客户端 idle 容忍更宽或有自己的 keepalive），故实际零触发；但架构上是 Responses 已修、CC/Gemini 未修的**不对称缺口**。
- **理想架构**：同 Responses——给 CC/Gemini 各定一个格式专属保活帧（CC：`data: {"choices":[{"delta":{}}]}` 或注释帧核定客户端容忍；Gemini：data-only 空 candidates 帧或核定容忍），经 `makeSseSink` 的 heartbeat hook 按 `streamKeepalivePingSec` 注入 + `synthetic:"keepalive"` 标记，帧型以各自 SDK 容忍契约为 oracle（比照 Responses 的 `refs/codex` + openai-node/python 三重容忍核验）。
- **为何暂缓**：无已知命中此 idle 边界的 CC/Gemini 消费者（价值未证）；每格式的保活帧型需独立核定客户端容忍契约（不能盲抄 Responses 的 `response.ping`）——属独立工作单元，同类修复模式（`learn-by-analogy`）但需各自 oracle。若将来某 ~300s-idle 消费者命中 CC/Gemini 即优先做。发现方：Task 2.1 keepalive 落地（2026-07-08，spec §3 R3 边界）。
- **若做需改什么**：① CC：定 CC 保活帧（核定 openai-node/兼容 SDK 对空 delta 帧容忍）+ `handler-v4.ts` 的 `makeSseSink` 接 heartbeat；② Gemini：定 Gemini 保活帧（核定 `@google/generative-ai` SDK 容忍）+ 同接；③ 各配容忍契约 oracle 测试 + 长静默注入回归；④ DESIGN「活的架构现状」Codex/Responses 行的「CC/Gemini 仍无 heartbeat」注记同步更新。

## protect_streaming 遥测无端点归因（Anthropic + Responses 共享全局计数器）

- **根因**：`recordProtectStreamingOutcome(outcome, retries)`（`src/lib/anthropic/protect-streaming-stats.ts:31`）是一个**无维度**的进程内全局聚合计数器（saved/exhausted/retreated 各一个数）。Anthropic buffered（`messages/handler-v4.ts`）+ Responses buffered（`routes/responses/handler-v4.ts:387` `onBufferedResolve`）**都喂同一个计数器**，`/api/status.protect_streaming` 快照无法区分某次 L2 engagement 来自哪个端点；per-entry `recordFeature("protect-streaming-retry", {outcome, retries})` 同样不带端点/格式维度。
- **当前行为（已核实无害）**：`/api/status.protect_streaming` 显示的是 Anthropic + Responses 合计的 L2 命中计数（saved/exhausted/retreated），诊断「buffered 重试整体是否在起作用」够用；但无法回答「Responses 的 buffered 命中率 vs Anthropic」。per-entry feature tag 仍在 history（可事后按 entry 的 endpoint 聚合），仅**实时 status 计数器**这一维度缺端点归因。
- **理想架构**：给计数器加 `format`/`endpoint` 维度（`Record<format, ProtectStreamingStats>` 或 counters bag 泛型化，见 skill `telemetry-architecture` 的可扩展 registry 三支柱），`recordProtectStreamingOutcome(outcome, retries, format)` 各端点传自己的 format，`/api/status.protect_streaming` 按端点分列；`recordFeature` 的 meta 补 `format`。
- **为何暂缓**：per-entry history 已可事后按端点聚合（真值不丢，仅实时聚合视图缺维度）；加端点维度属遥测 registry 扩展工作单元（跨切面，牵动 status API + 前端展示），价值待「需实时对比两端点命中率」的运维需求证实。属「决定数据模型后的后续项」非「因范围大降级」。遥测架构见 skill `telemetry-architecture`。
- **若做需改什么**：① `protect-streaming-stats.ts` 计数器加 `format` 维度（`Record<ClientFormat, ProtectStreamingStats>`）+ `recordProtectStreamingOutcome` 加 format 参；② Anthropic + Responses 两 `onBufferedResolve` 各传自己 format；③ `getProtectStreamingStats` + `/api/status` 快照按端点分列；④ `recordFeature("protect-streaming-retry", {…, format})` 补维度；⑤ 前端 status 展示分端点。发现方：Task 3.2 Minor（2026-07-08，Responses 作 buffered 第二消费者时暴露共享计数器无归因）。

## ui-v4 列表↔详情「双入口」（Linear 式 peek + 整页）— shadcn 重设计的未来演进

- **背景（2026-07-10 设计讨论）**：ui-v4 正在讨论全面切换到 shadcn/ui（new-york 变体 + 锐角 + 可调色默认继承现有 Amber 暗色 + 标准密度）——决策见 ADR `ui-v4/docs/decisions/2026-07-10-ui-v4-shadcn-adoption.md`。列表↔详情的组织方式定了基调 **形态 A**：保留现有「整页详情」（详情独占全宽，契合 request-inspector「深看单条」的主任务）+ 补「连续性」（相邻请求 prev/next 快捷键翻页 + 返回列表定位 `?at=id`），以消除「孤岛式整页」这个真正违反直觉的根源（而非整页本身）。双入口（形态 C）作为未来演进被显式 defer，不砍。
- **当前行为**：Requests 列表 `/requests` → 点击**整页跳转** `/requests/:id`（`RequestDetailPage` + `DetailPanel` 占满主内容区，顶部「‹ 返回列表」）；Models 详情用**右侧抽屉**（两处详情模式不一致）。无 peek 面板、无相邻导航。
- **理想架构（形态 C 双入口）**：单击列表行 = **右侧 peek 面板**（快速扫读、不离开列表上下文）；回车 / 双击 = **整页详情**（深度审查，即现有整页视图）；深链 `/requests/:id` 直达整页。兼得「快速扫读比对」与「全宽深看」，与主流（Linear / Jira / 邮件客户端）双入口一致。
- **为何暂缓（用户 2026-07-10 决策）**：形态 A 已满足用户核心偏好（喜欢整页全宽）+ 补 prev/next 后同时满足通用直觉（连续浏览 + 不丢列表上下文），是最小改动解；双入口是**严格增量**演进，形态 A 不挡路（prev/next 与 peek 可共存演进）；peek 面板引入 master-detail 分栏基建 + 单击/回车双语义交互复杂度 + 用户教育成本，价值待「实测更多在扫读比对而非深看单条」后再证。属独立 UX 演进工作单元，非「因范围大降级」。
- **若做需改什么**：① 引入右侧 peek 面板组件（可复用 `DetailPanel` 的 segment 渲染、窄宽版）；② 列表行「单击 → peek / 回车 · 双击 → `navigate(/requests/:id)` 整页」的双语义路由；③ peek 与形态 A 的 prev/next 快捷键协调（peek 内也可 j/k 翻相邻）；④ Models 详情统一到同一双入口（替换现抽屉，或把抽屉视作 peek 的一种）；⑤ 交互 + 键盘可访问性测试。**前置**：形态 A（整页 + prev/next 连续性）先落地。发现方：ui-v4 shadcn 重设计布局讨论（2026-07-10）。

## Vue 模型退役 + CSV 移除留下的孤儿（2026-07-10，已解决）

退役 Vue `/models` 视图 + 移除 ui-v4 CSV 导出后，两处成孤儿，**已按用户决策清理**（2026-07-10，commits `ee838f63` + `62d14d7d`）：删 `ui/src/components/ui/JsonViewerSurface.vue`（+ detail-page.test.ts 惰性 stub）、删 ui-v4 `sortModelRows` 及其两处测试与连带 unused imports。表格自身排序（TanStack `getSortedRowModel`）不受影响。**残留独立 refactor（未做）**：ModelsPage 的 `sorting` 受控 lift 现仅用于把排序态传给 ModelsTable，若嫌多余可下沉回表格内部（TanStack 自持）——属独立小重构，非孤儿。

## Requests 列配置的键盘 a11y 路径（2026-07-11，暂缓）

- **根因**：列配置特性（resize + reorder，spec `2026-07-11-ui-v4-requests-column-config`）的两个拖拽交互都只走指针设备。
- **当前行为**：列宽 resize 手柄仅 `onMouseDown/onTouchStart`（无键盘调宽）；列 reorder 的 `DndContext` 仅注册 `PointerSensor`（无 `KeyboardSensor` + `sortableKeyboardCoordinates`）。键盘用户无法 resize/reorder 列（仍可经 Columns 菜单显隐 + Reset）。
- **理想架构**：① reorder 加 `KeyboardSensor({coordinateGetter: sortableKeyboardCoordinates})`；② resize 手柄改可聚焦元素 + 方向键调宽（或提供数字输入）。
- **为何暂缓**：本期 spec 明确只要求指针拖拽；键盘路径是正交增强，不阻塞核心可配置能力。内部工具、单用户，优先级低。
- **若做需改什么**：`RequestsListPage` 的 `useSensors` 加 KeyboardSensor；`SortableHeaderCell` 补键盘激活语义；resize 手柄换 focusable + keydown 调 `columnSizing`；补键盘交互测试。发现方：column-config Task 3 审查（2026-07-11）。

## Responses via-chat-completions fallback 子路径未采用块级 buffered（flushResponse post-loop 结构不兼容）

- **根因**：Responses HTTP 的 **via-chat-completions fallback**（模型不支持 `/responses` → CC 上游 + CC→Responses translator）的终止生命周期 `output_item.done` + `response.completed` 由 `codec.flushResponse(env)`（`src/routes/responses/handler-v4.ts:454` post-loop 闭合 drain）在 driver 循环**外**合成——translator `translate()` 只发 `output_item.added`（`src/lib/openai/translate/responses-to-cc-request.ts:297,345`），`.done`/`.completed` 只在 `flush()`（`:418,446,459`）产出。故 buffered 循环**内**：块级 `commitBoundaries` 永不见 `output_item.done`、`sawMessageStop`（`acc.status`）drain 时仍 false → driver 误判干净 fallback 收尾为截断、重试到 exhausted。与 Gemini（§7.4，`flushResponse` post-loop 不可见）**同根因**。
- **当前行为（已修为无害）**：P2 Task 3 把 fallback 子路径**排除 buffered、保持 live**（`bufferedConfigured && !viaFallback`，`src/routes/responses/handler-v4.ts:307`）；direct 子路径走块级 buffered。fallback 功能完整（live 收尾正确），仅缺 buffered 保护（截断→fail+保留 partial，与 buffered off 等价）。
- **理想架构**：把 `codec.flushResponse` 的终止生命周期产出重构进 driver 的 buffered 提交单元（`runResponse` 循环内产出 `output_item.done`/`response.completed`，或让 buffered sink 感知 handler 的 post-loop flush 作为最终 commit 边界）——则 fallback 与 direct 统一块级。Gemini 同一重构可一并解（两者都卡 flushResponse-post-loop）。
- **为何暂缓（不落地 speculative code）**：需动 translator 的 emit 时序（把 `flush()` 的终止事件前移进 `translate()` 的 finish_reason 处理，或让 driver 承接 handler post-loop flush）——跨 codec 结构改动，超出 P2「Responses HTTP 块级」范围；无已知 fallback-under-buffered 的生产命中（fallback 本身是回退路径）。
- **若做需改什么**：① CC→Responses translator 在见到 CC `finish_reason` 时在 `translate()` 内即产出 `output_item.done`（而非 `flush()`）；② 或 driver 增「handler-supplied 终结 flush」纳入 buffered 提交单元；③ 去 `handler-v4.ts` 的 `!viaFallback` 门控；④ fallback+buffered mid-stream drop 重试回归测试；⑤ 与 Gemini §7.4 排除条合并考虑。发现方：P2 Task 3（2026-07-12，读 `codec.ts:237` flushResponse + translator emit 点确证；行号已核对现状，非 brief 原始估值）。

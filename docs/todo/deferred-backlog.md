# 暂缓 backlog（从记忆库归位）

从记忆库降为引用层（2026-07-05）时归位的活 backlog。每条：现状 / 暂缓原因 / 若做需改什么。

## GHC server_tool_memory 默认关 — CAPI 接受性待探针

- **现状**：`anthropic.server_tool_memory` 默认关。GHC 只在 BYOK 直连注入 `memory_20250818`、CAPI 路径不注入，故本项目经 CAPI 发该 server-tool 类型 + `context-management` beta 的**接受性未实测**。
- **若做**：先用探针 / history `sseEvents` 实测 CAPI 是否接受（见 skill `empirical-verification`）；被拒时 `unsupported-beta-retry` 只自愈 beta、body 里的 tool 类型无自愈（属未来工作）。保持关直到实测接受。
- **权威现状**：skill `ghc-api-reference` + `docs/plan/ghc-feature-alignment-tool-search-cache-ttl-memory.md`。

## stripToolFields 预剥的深层可观测性（history/telemetry 维度）

- **现状**：`stripToolFields`（`message-tools.ts`）剥除未知 custom-tool 字段（如 `eager_input_streaming`）时仅发结构化 `consola.warn`（命名剥除字段 + 受影响 tool 数），与 sibling `stripServerTools` 同档。反应式腿经 `RetryAction.meta.strippedToolFields` 已可达；但**内置默认 / config / cache 的 proactive 预剥是常态路径**（首请求就零 round-trip），它不经重试、不进 history `sseEvents` / request-telemetry 维度。
- **暂缓原因**：`buildWirePayload`（B1/B2 ctx 初始化，非 prepare step）当前无事件发射通道，sibling `stripServerTools` 亦仅 warn；就地新建 telemetry 通道属跨切面改动，超出与 sibling 对齐的范围。对抗审查 M2 提出、判为「决定数据模型的后续项」。
- **若做**：给 prepare 阶段（或 `stripToolFields` 返回值）接一个能到达 history/request-telemetry 的结构化回执（剥除字段集 + 受影响 tool 数 + 来源 builtin/config/cache/hint），前端可选呈现（richest-data-flow）；同时可顺带给 `stripServerTools` 补同款可观测性。遥测架构见 skill `telemetry-architecture`。

## web_search hop 缺 tool-field 反应式学习（遗留管线边界）

- **现状**：`tool-field-rejection-retry` 只注册在 v4 codec 管线（`codec/anthropic/strategies.ts`）;web_search 双跳仍走**遗留** `runAnthropicPipeline`（`web-search-direct.ts` / `web-search/orchestrator.ts`），其策略表**不含**任何 reactive-rejection 策略（server-tool / structured-outputs 亦缺），遗留 adapter opts 也无 `excludeToolFields`。
- **当前行为（已核实无害）**：`stripToolFields` 的**预剥三源**（内置默认 + 端点级学习缓存 + config）经 `prepareAnthropicRequest` 对**两条路径都生效**——`eager_input_streaming` 及主路径已学到的字段在 hop 上照剥，端点级缓存跨路径共享。唯一残余缺口：**全新未知字段首次且仅出现在 web_search hop** 时，该路径裸 400 且不写缓存（几乎不可能——hop 携带与原请求相同 tools，新字段必先经 v4 主路径学到;且 `webSearchEnabled` 默认 OFF）。
- **暂缓原因**：与遗留 hop 简化管线边界一致（本就省略全部 v4 反应式策略）；补齐需给遗留 pipeline 加策略 + adapter opts 透传 `excludeToolFields`，属遗留管线退役范畴。发现方：交付审计 subagent（2026-07-07）。

## context-edits 回执 telemetry（7d 分布）
- **现状**：`applied_edits` 诊断回执已落地（commit f55fd93，`src/lib/anthropic/applied-context-edits.ts`，流式经 accumulator `message_delta` / 非流式经 handler 顶层，两路发 `recordFeature("context-edits-applied", {count, clearedInputTokens, types})`），进 observability feature 维度计数。
- **暂缓**（用户 2026-06-29"暂时不做"）：接进 `request-telemetry` 做 7d 持久分布（现只 feature 维度计数，无 cleared token 量直方图）；实证开启 `protectStreamingEscalateContext` / `contextEditingMode` 后真有非空 `applied_edits`（当前样本 req_1782713407242_1 全空回执）。
- **原因**：命中率 / 价值未知，先收集 feature 计数再决定是否加 telemetry 维度（YAGNI）。遥测架构见 skill `telemetry-architecture`。

## setup-claude-code CLI 尊重已有配置（+/~/- diff）

- **现状**：`src/setup-claude-code.ts` 写 `~/.claude.json`/`~/.claude/settings.json`。config-respect UX（检测已存在的自定义配置、破坏性覆盖前展示直观 `+/~/-` diff 并确认、区分 essential=默认写 vs extension=仅 opt-in）**未实现、未文档化**——此设计意图原挂在记忆 `feedback_tests_never_touch_real_env` 的一条 How-to 里（该记忆的主旨是测试隔离、此条属跑题内容），记忆降 stub 时归位至此以免丢失。
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

- **entryToGatingSummary 双源**（`ui-v4/src/components/requests/HistoryList.tsx`）：`?at=` 归属判定用的 HistoryEntry→summary gating 投影手写复制了后端 `toEntrySummary`（`src/lib/history/in-flight.ts`）的派生。已核实字段对齐、仅单条 `?at=` 路径、低漂移风险。**理想**：把后端 summary 投影里 gating 相关的纯函数下沉为可 `~backend/*` re-export 的共享 primitive，消除双源。**若做**：抽 `src/lib/history/` 里的 gating-projection 纯函数 + 前端 re-export，删前端手写副本。
- **response_sessions 孤儿映射未扫**（`src/lib/history/sqlite/write.ts` `deleteEntries`）：scoped delete 不清 `response_sessions`（该表对 entries_v2 无 FK）。与 `deleteSession` 同款行为、`clearAllEntries` 兜底、无害泄漏（非数据丢失）。spec §9 文字提过。**若做**：`deleteEntries` 内按被删 entry 的 response id 清对应 `response_sessions` 行，或加周期性 orphan sweep。
- **chip 日期标签 UTC vs popover 本地时区**（`ui-v4/src/lib/request-filters.ts` `activeChips` 用 `toISOString` / `DateRangePopover.tsx` 标签用本地）：非 UTC 时区跨午夜两处显示串可能差一天（epoch 值正确、筛选结果正确，仅标签串不一致）。**若做**：统一两处时区（都本地或都 UTC）。
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

# Plan: 可扩展运营 stats 框架（dimension/measure registry）+ 删除 lineage/sessions 物化表

> **实施状态：已完成**
> **落地**：b1ea54a
> **现状锚点**：`/api/stats`/`/metrics` 路由 + `src/lib/request-telemetry.ts`；spec/operational-stats-and-lineage-removal.md
> **备注**：9 commit 全落地；lineage/sessions 物化表已 DROP，/metrics 含 histogram（比 plan §7 更完整）

> **执行态（2026-06-23）**：6/9 commit 已落地（删除阶段 + agentId + telemetry registry 框架），剩 commit 7-9。
> **交接文档 + 每 commit self-contained 提示词** 见仓库 `.workflow/.scratchpad/operational-stats-handoff.md`（含已落地 commit 哈希、架构现状、并发上下文、踩坑、commit 7-9 kick-off 提示词、2 轮 review 结论）。续作先读它。

## Context（为什么做这个）

用户发现 anthropic 请求都带 session id，问是否按 session 聚合。一路调研 + 用户逐步收敛，需求演进为**持久、可长远扩展的多维度运营 stats**：

1. **session 聚合 header 修复**（已 commit `5d52c87`）。
2. **同 session 含主 agent + subagent**——`x-claude-code-agent-id` 标识 subagent（实测 ce6fd04e = main 18 + 3 subagent 16/11/7）。
3. **lineage 已死**——内容哈希重建对话树，500 root≈500 entry 零聚类（rootHash 含每轮漂移的 system[0]）；仅 anthropic、UI 零消费、codex 已有 `previous_response_id`。删。
4. **统计应持久**——用户洞察：统计在 entries GC 后保留（"这与投影不同"），session 浏览价值低（GC 后不需浏览），真正值得持久的是**运营 stats**。
5. **不用 OTel**——OTel 自动 instrumentation 在 Bun 损坏（Bun #29586/#32472/#30669），手动 metrics API 虽 Bun-safe 但 in-memory/无持久/无内建 UI、要外部 Prometheus+Grafana 才有价值——与"自包含 + 内建 WebUI + 文件持久"冲突。
6. **弱化 YAGNI、长远灵活**（用户明确指示）——telemetry 不做 5 个硬编码维度，做**可扩展 registry 框架**：加维度/指标/导出格式 = 注册一行，非六处编辑。

**关键现状**：已有 `request-telemetry.ts`——持久 per-model 遥测（per-model+global counters，5min×7d buckets，独立 JSON 文件持久、不随 SQLite GC 蒸发），前端 `VDashboardPage` 已展示。但内部是 **5 个硬编码 `let` map + 指标在 6 处手抄**（`:104-105/122/136/152/197-208/285-293/484-496`）——不可扩展。

**目标架构**：删 lineage + 删 sessions 物化表（不做 session 浏览）；把 request-telemetry **重构成 dimension/measure registry 框架** + 加 endpoint/client/agentKind/tool 维度 + per-token-type 成本；新 `/api/stats` 端点（含基数 cap + top-N）；前端 dashboard 扩展。

### 对抗 review 精炼（2 轮 full review，已核验 file:line）
- **扩展性（弱化 YAGNI 视角）**：维度=first-class registered extractor `(entry, ctx) => key|null`；指标=开放 `counters: Record<string,number>` bag + **预留 histogram slot**（latency p50/p95，sum-only 结构做不了，结构性必需）；持久=通用 `{version, dimensions:{name:{sinceStart, buckets}}}`（加维度/指标=数据，无 V4 bump）；extractor 签名取 `(entry, ctx)` 两者（修成本数据流 + 开放 ctx-derived 维度）；成本 per-token-type（保留 token 分量，snapshot 按 pricing 算，历史可重算）；`/api/stats` 专用端点（不塞 health-poll status）+ 高基数维度 server-side top-N。
- **删除安全（正确性视角，全部已核验）**：`getSessionEntries` 是**活消费者**（conversation-rebuild.ts:59，只用 queryEntries → **保留**）；`exportHistory`（stats.ts:67）调 listSessions → 改 derived；`deleteSession` rebase（existence check off queryEntries，删 `DELETE FROM sessions`）；multiplier 在 `event.ctx` 非 entry（sink 须读 ctx）；tool 还原名 mapper 在 ctx 非 entry（C4，见「四」处理）；per-client/per-tool **无界基数**（须 cap + "other" 桶）。

## 执行前置
已做 2 轮对抗 full review（本节精炼）。先把本 plan 转写为 `docs/rfc/operational-stats-and-lineage-removal.md`。实现中每个删除 commit 前跑 census 核对（下「Commit 序列」附 per-commit census）。

---

## 设计

### 一、删除 lineage 子系统

删 `src/lib/history/lineage/*`(6)、`scripts/backfill-lineage.ts`、`tests/history/lineage/*`、`tests/history/sqlite/lineage-schema.unit.test.ts`。scrub：`entries.ts`（import+digest try/catch+TerminalWriter `digest?`+`terminalWriter(entry)`）、`write.ts`（import+`runLineageInsert`+`digest?` 参数）、`handler.ts`/`route.ts`（`handleGetLineage`/`handleGetConversations`+路由）、`openapi-compat.ts`（2 registerPath）。保留 `migrate-legacy-entries.ts`（scrub 注释）。orphan：`schema.ts` 删 CREATE + `connection.ts` 加 `DROP TABLE IF EXISTS entry_lineage; DROP TABLE IF EXISTS entry_produced_tool_ids`。

### 二、删除 sessions 物化表（精确 census：table-dependent 删 / entries-derived 保留）

**table-dependent（删）**：
- `sessions` 表 CREATE（schema.ts:39-50）+ `recomputeSession`（write.ts:158）+ finalize 调用（write.ts:240）+ `UPSERT_SESSION_SQL`/`RECOMPUTE_SESSION_*_SQL` + `upsertSessionMeta`（write.ts:324，死）+ `Session.toolsUsed`/`tools_used_json`（schema/read.ts:222/types.ts:311）。
- `listSessions`/`getSessions`/`getSessionById`（read.ts + sessions.ts barrel + handler）。
- session 浏览 REST：`handleGetSessions`/`handleGetSession`/`/api/sessions[/:id]` 路由。
- **消费者处理**：`exportHistory`（stats.ts:67）的 `sessions` 字段改 **derived**（export 时一次性 `GROUP BY session_id`，低频，richest-data-flow——export 附 session 汇总有价值，不去掉）；或与用户确认是否保留该字段。
- `connection.ts` 加 `DROP TABLE IF EXISTS sessions`（response_sessions 独立、无 FK，已核验 schema.ts:39-55，不受影响）。

**entries-derived（保留 / rebase）**：
- **`getSessionEntries` 保留**（conversation-rebuild.ts:59 活消费者；只用 `queryEntries({sessionId})` 不碰 sessions 表）。
- `queryEntries({sessionId})` + `entries_v2.session_id` 列 + `entry.sessionId` + `VDetailPage` viewSession 过滤——全保留。
- `deleteSession` **保留但 rebase**：existence check 改用 `queryEntries({sessionId})`/in-flight（非 `getSessionById`）；删 `DELETE FROM sessions`（write.ts:300）+ `clearAllEntries` 的 sessions 行（write.ts:314）；`history.session_deleted` 事件保留。UI `api.deleteSession`（http.ts）保留。
- `response_sessions` + codex `previous_response_id` 链——独立，不动。

**测试 census（每个在其 owning commit 编辑/删）**：`history-sessions.it.test.ts`（删）、`history-api.it.test.ts`（删 sessions API describe + 改 export test）、`write-read.unit.test.ts`（删 session-aggregate 断言 :155-278，保留 deleteSession entries 断言）、`history-store.it.test.ts`（删 getSessions/getSessionEntries 断言或改 derived）、`history-ws-integration.it.test.ts`（deleteSession）、`history-summary.it.test.ts`、`incremental-recovery.it.test.ts`、`management-routes.http.test.ts`、`e2e-ui/history-mocks.ts` + pw、`history-fixtures.ts`。**UI**：删未渲染的 `fetchSessions`/`fetchSession` + `useHistoryData.ts:230` Promise.all 里的调用 + `sessions` ref + Session re-export。

### 三、agentId plumbing（含 entries_v2.agent_id 列——加上，不 waffle）

agentId 流 ctx→entry（telemetry agentKind）+ **持久进 entries_v2.agent_id 列**（review MEDIUM-2：richest-data-flow，cheap，future-proof `queryEntries({agentId})` / per-agent 诊断 / telemetry agentKind backfill；不加列则永久 foreclose）。镜像 sessionId：
- header：`getAgentIdFromHeaders`（`x-claude-code-agent-id`，复用 `normalizeSessionId`）。re-export 经 store/index。6 codec/handler 提取点加 `agentId:`。
- context：`types.ts`/`request.ts`/`manager.ts`（镜像 sessionId 全链）。observability：`events.ts` snapshot + `activity-summary.ts:104`。
- history+SQLite：`HistoryEntry.agentId` + `entries_v2.agent_id` 列（serialize/write/read + migration `migrateEntriesColumns` wanted[] + 索引 `idx_entries_v2_agent` post-ALTER）+ `QueryOptions.agentId`（per-agent 查询）。

### 四、telemetry 重构为 dimension/measure registry 框架 —— 核心

**维度注册表**（取代 5 硬编码 map）：
```ts
interface StatDimension { name: string; extract: (entry: HistoryEntryData, ctx: RequestContextSnapshot) => string | null }
const DIMENSIONS: StatDimension[] = [
  { name: "model",     extract: (e) => e.outboundResponse?.model ?? e.inboundRequest.model ?? "unknown" },
  { name: "endpoint",  extract: (e) => e.endpoint },
  { name: "client",    extract: (e) => normalizeClient(e.httpHeaders?.inboundRequest) },   // user-agent/x-app 归一
  { name: "agentKind", extract: (e) => e.agentId ? "subagent" : "main" },
  { name: "tool",      extract: ... },   // 见 C4 处理（多 key：一 entry 多工具）
]
```
record loop：`for (const dim of DIMENSIONS) { const key = dim.extract(entry, ctx); if (key) accumulate(dim.name, key, measures) }`。**加第 6 维（per-stop-reason/per-status/per-git-sha…）= 注册一行**，record/persist/load/snapshot 全靠遍历 registry。model 维度为第一注册项（back-compat alias 保留现有 `modelsSinceStart` snapshot 字段名）。
- **tool 维度特殊**（C4）：一 entry 可含多 tool_use→多 key，extractor 返回 `string[]`（或 dim 标 `multi: true`）；从 `entry.outboundResponse` 提 tool_use name。**还原名**：mapper 在 `ctx.toolNameMapper` 非 entry/snapshot——本次 tool 维度记 **wire 名**（`sanitizeToolNames` 默认 false 时 wire==client），RFC 文档化该 caveat + 暂缓"finalize 时把 restored 名投影进 entry"（避免为默认关的配置背契约）。

**指标=开放 counters bag + histogram slot**：
```ts
interface StatAccumulator { counters: Record<string, number>; durationHist: number[] }  // 固定 log-spaced buckets
```
counters：`requestCount/successCount/failureCount/totalDurationMs/inputTokens/outputTokens/cacheReadTokens/cacheCreationTokens/reasoningTokens`（现有，迁进 bag）+ 新增 = 加 key（零累加代码改动）。**durationHist** 预留（latency p50/p95，sum-only 做不了，结构性必需——本次铺 slot，百分位计算可后续）。
- **成本 per-token-type**（HIGH-2）：**不存单标量 estCost**，保留各 token 分量（已有）+ snapshot 时按 pricing 算（`tokens_type × multiplier_or_rate`）。multiplier 从 **`ctx.multiplier`**（events.ts:81，已核验 terminal event 带 ctx）。历史可随 pricing 演进重算（token 分量保留）。token-based 账户 multiplier undefined→cost 段省略。

**通用持久格式**（CRITICAL-3，无 V4 treadmill）：
```jsonc
{ version, dimensions: { [name]: { sinceStart: {[key]: counters}, buckets: {[ts]: {[key]: counters}} } } }
```
counters 开放 bag。加维度/指标=数据，**无版本 bump、无 loader 分支**。loader 结构化校验（truthy+number，复用现有 quarantine `:388-405`）；V1/V2 旧文件一次性迁进通用 envelope（model 维度），缺维度从空起、不丢历史。**forward-compat**：旧 reader 容忍新 reader 写的额外 dimension/metric key（round-trip 不丢）。

**TelemetrySink**：`handle` 传 `(event.entry, event.ctx)` 给 record（现仅 entry+model）。aborted 仍排除（已核验 sink 只订阅 completed/failed）。

### 五、`/api/stats` 端点 + 基数 cap（不塞 health status）

- **新 `GET /api/stats?dimension=<name>&window=<sinceStart|7d>&limit=<N>`**（HIGH-3）：各维度 breakdown，**server-side top-N**（按 requestCount/tokens 排序取前 N + "other" 聚合余下）。`/api/status` 只留 totals 摘要（不塞全维度，保 health-poll 小）。
- **基数 cap**（H1，无界内存/JSON 防护）：per-client/per-tool 等高基数维度，`sinceStart` + 每 bucket 的 key 数超 cap（如 200）时新 key 并入 `"other"`。`normalizeClient` 先把 user-agent 归一到 `claude-cli`/`vscode`/`<bucketed>` 降基数。model/endpoint/agentKind 低基数免 cap。registry 维度可标 `cardinality: "bounded"|"capped"`。

### 六、前端 stats 仪表盘

复用 `useModelTelemetry`/`useDashboardStatus`/`CompactTimelineBarChart`/`VDashboardPage`：
- 类型从 `~backend` re-export（通用 dimension breakdown 形状）。
- 消费 `/api/stats`（按需取各维度，分页/top-N）。
- panels：per-endpoint/client、main-vs-subagent token 占比（堆叠条/饼）、per-tool 频次、per-model 成本（per-token-type）。趋势复用 `CompactTimelineBarChart`。
- 遵守 `ui/CLAUDE.md` + web-design（rounded:0、暖琥珀、有意层次、`.state-shell`、图表入设计系统）。

### 七、可选 `/metrics` Prometheus-text 桥（暂缓，但 registry 使其 trivial）

registry 落地后，`/metrics` = 对 DIMENSIONS×keys×counters 的**通用投影**（~30 行、零依赖、不引 OTel SDK）。本次只**铺 seam**（registry + snapshot 形状使其后续一行接），endpoint 本身 default-off 暂缓。RFC 记形态。

---

## Commit 序列 + invariants（每个中间 commit 编译 + 测试绿；附 per-commit census）

1. `refactor(history): remove lineage write/compute path` — `entries.ts`+`write.ts`（移除 digest/`runLineageInsert`）+ 删 `lineage-write-path.it.test.ts`。_Inv_：finalize 无 lineage 行；`insertCompletedEntry(entry)` 单参（已核验 commit-1 independent-green，`Session` import 留到 commit 4）。
2. `refactor(history): remove lineage REST + OpenAPI` — handler/route/openapi-compat + 删 `lineage-query.it`/`lineage-conversations.it`。_Inv_：无 `/lineage`·`/conversations`。
3. `chore(history): delete lineage modules + drop dead tables` — 删 `lineage/*`+脚本+测试；schema 删 CREATE；connection 加 DROP。_Inv_：`grep -rn lineage src/` 干净。
4. `refactor(history): remove sessions materialized table + rebase derived consumers` — 删 table-dependent（「二」）；`exportHistory` sessions 改 derived；`deleteSession` rebase；connection 加 `DROP TABLE IF EXISTS sessions`；**同 commit 编辑全部 census 测试**（history-api/write-read/history-store/history-ws/summary/incremental-recovery/management-routes/e2e mocks + history-fixtures）+ 删 history-sessions.it；UI 删 fetchSessions+Promise.all 调用+ref+re-export。_Inv_：保留 getSessionEntries/queryEntries{sessionId}/deleteSession(rebased)/response_sessions/codex；`/api/export` 仍绿（derived sessions）；reaper 不碰。
5. `feat(history): agentId plumbing + entries_v2.agent_id column` — 「三」全部 + migration + getAgentIdFromHeaders unit。_Inv_：entry 带 agentId（main=undefined/subagent=id）+ 持久列 + queryEntries({agentId})；TelemetrySink 可读。
6. `refactor(telemetry): dimension/measure registry framework + generic persistence` — 把现有 5-map 重构成 registry（model 为首维、back-compat snapshot 字段）+ counters bag + durationHist slot + 通用持久 envelope + V1/V2→generic 迁移 + extractor `(entry,ctx)`。unit（registry 累加/迁移/forward-compat round-trip）。_Inv_：**逐字节等价现有 model telemetry 行为**（golden snapshot 锁）+ 持久文件可加维度无 bump。
7. `feat(telemetry): endpoint/client/agentKind/tool dims + per-token cost + cardinality cap` — 注册 4 维 + normalizeClient + tool multi-key（wire 名）+ per-token-type cost（ctx.multiplier）+ 基数 cap/"other" + TelemetrySink 传 ctx。unit（各维度/cost/cap/"other"溢出）+ .it（settled→各维度，aborted 不计，模拟 GC 后持久仍在）。_Inv_：全维度持久记录，高基数有界。
8. `feat(api+ui): /api/stats endpoint + operational stats dashboard` — `/api/stats`（dimension/window/top-N）+ status 留 totals 摘要 + UI panels。.http（/api/stats 各维度 + top-N/"other"）+ vitest mount。_Inv_：仪表盘展示全维度；health-poll status 不膨胀。
9. `docs: deprecate lineage RFCs + add operational-stats RFC + DESIGN sync` — 标记 lineage 文档废弃；落 `docs/rfc/operational-stats-and-lineage-removal.md`（registry 框架 + OTel 决策 + tool wire-name caveat + /metrics seam + 暂缓项）；回填 DESIGN.md「活的架构现状」+ 运行时选项。删过时 lineage memory。

---

## 验证

- **unit**：`getAgentIdFromHeaders`；registry 累加（任意维度/任意 counter）；V1/V2→generic 迁移无损 + forward-compat round-trip（旧 reader 容忍新 key）；normalizeClient；tool multi-key wire 名；per-token cost（ctx.multiplier、undefined→省略）；基数 cap "other" 溢出；durationHist slot 存在。
- **golden（commit 6 关键）**：registry 重构前后 model telemetry snapshot 逐字节等价（先在旧码锁 golden）。
- **.it**：settled 事件→各维度 breakdown；aborted 不计；**模拟 entries GC 后 telemetry 文件持久仍在**（对比删掉的 recompute 蒸发）；agentKind 主/子占比反映 ce6fd04e shape。
- **.http**：`/api/stats?dimension=*` 各维度 + top-N/"other"；`/api/status` 只含 totals 摘要（不膨胀）；`GET …/lineage`·`/conversations`·`/api/sessions` 现 404；`/api/export` 仍绿（derived sessions）。
- **live（4141）**：`curl …/api/stats?dimension=agentKind` → main vs subagent token 占比；`?dimension=tool` 频次；`?dimension=client` + 高基数 "other"；触发 GC 后 stats 仍在。
- **回归**：`grep -rn lineage src/` 干净；codex `previous_response_id` + conversation-rebuild（getSessionEntries）仍工作；含 orphan lineage/sessions 表的 live DB 副本启动→DROP 生效。
- 改 `.ts`/schema 跑 `bun run test:backend`；UI 跑 `test:ui`+`typecheck:ui`；改 `.ts` 跑 `typecheck`。

## 不做（YAGNI 已弱化——以下是真不需要 / 暂缓）
- **OTel 作引擎**（场景不匹配 + Bun 自动 instrumentation 损坏）。
- **`/metrics` endpoint 本体**（registry 已铺 seam，接外部监控时一行接；本次只留 seam）。
- **latency 百分位计算**（durationHist slot 本次铺，百分位 readout 后续——结构已不 foreclose）。
- session/agent 浏览视图（用户定不做）。
- tool restored-name 投影进 entry（默认 sanitize off 时 wire==client；开启时记 wire 名 + 文档化，避免为默认关配置背 finalize 契约）。

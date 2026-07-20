# Token Usage 语义归一化 — 全面修复计划（v2，已过对抗审查）

> **实施状态：✅ 已完成（2026-07-05）。** 全部落地并测试通过。commit 序：`f56f4eb`（共享原语 + 生产端 5 站点 + abort/fail + via-responses）→ `d621651`（展示层 MetaSegment/DiagnosticBar/AgentLane/CSV）→ `65246dc`（`usage_normalized` 列 + 写路径）→ `eb9322c`（backfill 模块 + 接线）→ `b263b46`（lint/probe）→ `1ff6ab0` + `64e980a`（**交付前 subagent audit 发现并修复的 CRITICAL**：Gemini 流式历史行本就净值、被 backfill 双减，靠 `sseEvents` 结构信号区分，覆盖 top-level/inbound_response stage + legacy blob）。
>
> **计划外的关键修正**（audit 战果）：backfill 的 Gemini 双减是 plan 阶段未预见的——生产端修复正确区分了 Gemini 流式/非流式，但 backfill 初版对所有 gemini endpoint 一律减。经 3 轮实现审查（各配活探针）闭合。第五部分「接受的局限」（telemetry 7d 直方图不可回填）如期保留。
>
> 权威现状见 [docs/DESIGN.md](../DESIGN.md) `src/lib/history/` 行的「usage 净值约定 + usage-normalize-backfill.ts」段。审查伴随文件见同目录 `-review*.md`。

## Context（为什么做这个改动）

`UsageData.input_tokens`（[types.ts:179](src/lib/history/types.ts#L179)）的 canonical 约定应为 **Anthropic 净值**：`input_tokens` = 未缓存净输入，与 `cache_read_input_tokens`/`cache_creation_input_tokens` **互不相交**，`total = 三者相加`。[sessions-agg.ts:30](src/lib/history/sqlite/sessions-agg.ts#L30) 的 `SUM(input)+SUM(cache_read)+SUM(cache_creation)` 与 Anthropic builder（[recording.ts:104](src/lib/request/recording.ts#L104)）共同反证此约定既定。

**Bug**：OpenAI/Responses/Gemini 三腿把上游"含缓存总输入"（`prompt_tokens`）直接当 `input_tokens`，`cache_read` 是其**子集**，违反约定。后果：成本重复计费缓存（[request-telemetry.ts:384](src/lib/request-telemetry.ts#L384)）、聚合双计（sessions-agg）、detail 缺 cache 分解。

**独立 oracle**：GHC 官方 `refs/ghc-api-py/ghc_api/translator.py` + `streaming.py` 自己做 `input_tokens = prompt_tokens − cached_tokens`（只减 cached、不减 cache_creation——OpenAI 无该概念）。方向逐字一致。

**决策**：用户确认 **全做（含历史 backfill）**。本 v2 已吸收两轮对抗审查（CRITICAL：usage 不在 head blob 而在独立 `outbound_response` stage 行；HIGH：破坏性算术需 per-row 幂等标记而非 cursor-only）。

---

## 第一部分：共享原语 + 生产端（fix-all-comparison-sites）

**新建** [src/lib/request/usage-normalize.ts](src/lib/request/usage-normalize.ts)：

```ts
import type { UsageData } from "~/lib/history/types"
export function netInputTokens(totalInput: number, cacheRead = 0, cacheCreation = 0): number {
  return Math.max(0, totalInput - cacheRead - cacheCreation)   // oracle: GHC translator.py
}
export function usageFromTotalInput(args: {
  totalInput: number; output: number; cacheRead?: number; cacheCreation?: number; reasoning?: number
}): UsageData   // input_tokens=net; 非零才挂 cache_*/reasoning
```

归一化在 **builder/handler 出口层，accumulator 不动**（acc 保留上游原始 total+cached）。

| 站点 | 文件:行 | 源 |
|---|---|---|
| A 流式 OpenAI | [recording.ts:135-142](src/lib/request/recording.ts#L135) | `acc.inputTokens`+`acc.cachedTokens`+`acc.reasoningTokens` |
| B 流式 Responses | [recording.ts:182-189](src/lib/request/recording.ts#L182) | `acc.inputTokens`+`acc.cachedInputTokens`（保留 `responseId`） |
| C 非流式 chat | [chat-completions/handler-v4.ts:245-255](src/routes/chat-completions/handler-v4.ts#L245) | 原始重命名 `rawUsage`：`prompt_tokens`+`prompt_tokens_details.cached_tokens`+`completion_tokens_details.reasoning_tokens` |
| D 非流式 responses | [responses/handler-v4.ts:214-227](src/routes/responses/handler-v4.ts#L214) | `resp.usage.input_tokens`(含缓存总量)+`input_tokens_details.cached_tokens` |
| E 非流式 gemini | [gemini/handler-v4.ts:206-213](src/routes/gemini/handler-v4.ts#L206) | **直接** `usageFromTotalInput({ totalInput: chat.usage.prompt_tokens, cacheRead: chat.usage.prompt_tokens_details?.cached_tokens, ... })`（与 C/D 同构；**不用** `extractUsageMetadata`——它返回 Gemini 形状非 `UsageData`，审查 M3 纠正） |

流式 truncation 调用方（chat:400/responses:355/[ws.ts:375](src/routes/responses/ws.ts#L375)）走 `partial.usage`，随 A/B 自动修好。

**abort/fail 路径**（richest-data-flow：带 cache_read+净值化）：chat [:368/:381](src/routes/chat-completions/handler-v4.ts#L368)、responses [:308/:320](src/routes/responses/handler-v4.ts#L308)、ws [:335/:348](src/routes/responses/ws.ts#L335) 全改经 helper。

**附加（审查 L1，richest-data-flow）**：via-responses fallback 的 [ccUsageToResponsesUsage](src/lib/openai/translate/responses-to-cc-request.ts#L523) 丢弃 `cached_tokens` → 补透传 `input_tokens_details.cached_tokens`。

**Anthropic 腿全部不动**（builder/messages/web-search/warmup/count-tokens 已净值/合成/N-A，审查 L2 确认生产端无遗漏）。

---

## 第二部分：展示层补全（richest-data-flow）

- **detail 补 cache 分解**：[MetaSegment.tsx:37-42](ui-v4/src/components/detail/segments/MetaSegment.tsx#L37) + [DiagnosticBar.tsx:31-35](ui-v4/src/components/detail/DiagnosticBar.tsx#L31) 在 `↑input ↓output` 后条件拼 cache_read/cache_creation/reasoning（非零才显）。
- **AgentLane 前端 SUM（审查 M2，此前漏列）**：[AgentLane.tsx:14](ui-v4/src/components/sessions/AgentLane.tsx#L14) `laneSummary` 只累加 `input_tokens`，与 sessions-agg 加三项不一致 → 净值化后 lane 汇总丢缓存部分。改为一并累加 cache_read/cache_creation 并在 lane 标签体现（对齐 sessions-agg 语义）。
- **CSV 导出补列**：[history/stats.ts:81-99](src/lib/history/stats.ts#L81) headers/rows 严格对齐插 cache_read/cache_creation/reasoning。
- **无需改**：`tokenIn`（[activity-row.ts:46](ui-v4/src/lib/activity-row.ts#L46)）自动变正确；`rowAnomaly` 20000 阈值（[:87](ui-v4/src/lib/activity-row.ts#L87)）—— cacheMiss 行本因 `!cache_read` 短路，净值化只缩小有缓存行 input，判定不变（审查 L4 确认），仅加测试锁定。

---

## 第三部分：历史 backfill（v2 重设计 — 吸收 CRITICAL-1/-2 + HIGH-2）

### 3.1 正确的持久化目标（CRITICAL-1/-2，已亲验）

usage 存三处，随行布局不同：
- **列** `entries_v2.{input_tokens,cache_read,cache_creation}`（[buildHeadRow](src/lib/history/sqlite/serialize.ts#L210) 写、list/sessions-agg/stats 读）。
- **finalized 行**：`outboundResponse` 被 `STAGE_TOP_KEYS`（[serialize.ts:140](src/lib/history/sqlite/serialize.ts#L140)）剥出 head blob，作**独立 `outbound_response` stage 行**（每行 `compress(payload)` 单帧、zstd 往返逐字保真；`request_group` 帧是 inbound-only 不含它，[serialize.ts:404](src/lib/history/sqlite/serialize.ts#L404)）。**detail 页经 `assembleFullEntry` 从该 stage 行还原 usage**。**每 entry 只有一条 outbound_response 行**（审查 MEDIUM-1 实证：非 final 失败 attempt 走 `setAttemptError` 只写 error 从不写 response，[serialize.ts:493](src/lib/history/sqlite/serialize.ts#L493) 的 `if(a.response)` 守卫恒 false）。
- **legacy 单 blob 行**（`stageRows.length===0`）：head blob 即完整 entry，含 `outboundResponse.usage`。

→ backfill 每行须：改列 + 改 `outbound_response` stage 行 blob（decompress→patch→compress→`UPDATE entry_stages SET blob_gz WHERE entry_id=? AND stage='outbound_response'`）+ legacy 行改 head blob。**两腿（列源、blob 源）各自独立读取+独立减法**（审查 MEDIUM-2 红线：绝不用 `assembleFullEntry` 得单个共享 usage 对象再对两源各减一次——内存共享引用会把 `input -= cache_read` 跑两遍腐蚀数据）。同一事务写出，避免 list/detail 分叉。

### 3.2 幂等主闸 = per-row 标记列（HIGH-1/-2；不靠 cursor/epoch）

破坏性算术（`input -= cache_read`）二次执行会腐蚀，且 re-finalize（新生产码写净值）/部署窗口会让 cursor/epoch 方案失效。**参照 search-index 的 per-entry 探针哲学**，加真实"已处理"判别器：

- **schema DDL**：`entries_v2` 加列 `usage_normalized INTEGER NOT NULL DEFAULT 0`（常量 DEFAULT，SQLite ADD COLUMN O(1) 不重写行——官方文档 + 项目 `pinned` 先例确证）。**走 reconcile 地板**：加进 [migrateEntriesColumns](src/lib/history/sqlite/connection.ts#L277) 的 `wanted` 数组（与 `pinned INTEGER NOT NULL DEFAULT 0` 逐字同构），**不走 Umzug**（`MIGRATIONS` 数组有意为空，[migrations/index.ts:64](src/lib/history/sqlite/migrations/index.ts#L64)；审查 HIGH-1 纠正 v1 的"reconcile+Umzug"矛盾表述——同列两处加会 duplicate-column wedge）。
- **写路径（审查 MEDIUM-3/LOW-1，写侧改动非读崩）**：`EntryRow` 接口（[serialize.ts:12](src/lib/history/sqlite/serialize.ts#L12)）+ `INSERT_ENTRY_SQL` 列清单/bind（[write.ts:34](src/lib/history/sqlite/write.ts#L34)）+ buildHeadRow 加列并**恒置 1**；所有 `ON CONFLICT DO UPDATE`（eager/status/finalize 多次 re-upsert）SET 含 `usage_normalized=excluded.usage_normalized`。**红线**：part1 净值化必须与写路径置 1 **同 commit/先于**（否则"标记 1 但列值仍含缓存"→ backfill `WHERE=0` 跳过 → 未净值行永久错，真数据 bug）。
- **backfill**：`WHERE usage_normalized=0`（endpoint 只决定**是否做减法**非缩面正确性）：`anthropic-messages` 行已净值 → 只置 `=1` 不动数字；`openai-*/gemini-*/responses` → 净值化列+stage/head blob 后置 `=1`。标记列使 re-run/re-finalize/竞态全部安全。

### 3.3 运行机制（参照 [search-index-backfill.ts](src/lib/history/sqlite/search-index-backfill.ts)）

**新建** [src/lib/history/sqlite/usage-normalize-backfill.ts](src/lib/history/sqlite/usage-normalize-backfill.ts)：`(started_at,id)` keyset 分页 + cooperative-stop + never-throw（top-level 防 unhandledRejection）+ 靶向解压（只解 outbound_response/head blob，不碰 sse_events/request_group 大帧）。
- **per-entry tx（沿用 [search-index-backfill.ts:196](src/lib/history/sqlite/search-index-backfill.ts#L196) 模式，审查 LOW-2）**：每行独立 `db.transaction`（列+blob+标记一并）；**解压/压缩在 tx 外**（CPU 重活不持 DB 引用/不 stall 关键路径），tx 内只 UPDATE。per-entry `try/catch` 隔离坏 blob：失败行**保持 `usage_normalized=0`**（不置标记）→ 下次全扫（`WHERE=0`）自动重试，标记列保证重试安全、**不静默漏改**（修 v1 批级大事务，也修上轮 HIGH-2 的 cursor 静默跳过）。
- **version guard** 仅作"整体完成"短路（全扫完才置位）；cursor 仅单次运行内 keyset 续跑优化；**正确性由标记列兜底**，不依赖 cursor/epoch。
- **竞态（审查 MEDIUM-2）**：backfill 与 re-finalize 都在 `db.transaction`（bun:sqlite 单连接单线程串行化，无 SQLITE_BUSY/交错）；re-finalize 写净值+`usage_normalized=1` → backfill 见 =1 跳过。无 SQL 触发器（`UPDATE` 不触 CASCADE，无 `.changes` 陷阱）。

**接线（审查 L1 修正路径）**：[state.ts:141](src/lib/history/state.ts#L141) 加 `startUsageNormalizeBackfill()`；在 `startUsageNormalizeBackfill` 内部 `.then(startSearchIndexBackfill)` 串联（usage 先跑更快）；[start.ts:542](src/start.ts#L542) 只启 usage（它链起 search-index）；[stopHistoryBackgroundWork:101](src/lib/history/state.ts#L101) 加 `stopUsageNormalizeBackfill()`。**不走 Umzug MIGRATIONS 数组**（数据回填是 background re-entrant，只有 3.2 的 ADD COLUMN 走 DDL migration）。

---

## 第四部分：测试（TDD，独立 oracle，审查 M3/M4 加固）

- **helper 单测**（新）：`netInputTokens(100,30)→70`（GHC oracle）、`(30,100)→0` 夹逼、非零才挂、互斥不变量用独立算的原始总量比对（非自洽）。
- **流式/非流式 golden**：openai/responses/gemini builder+handler，`prompt=1000,cached=400→input=600,cache_read=400`；断言 `acc.inputTokens===1000` 不变（锁归一化在 builder 层）；gemini 断言与流式 `geminiUsageFromMeta` 一致。
- **abort/fail golden**：settled-abort+stream-error 断言 `ctx.abort/fail` 收净值**且带 cache_read**。
- **聚合期望值（审查 HIGH-1）**：backfill 后 `sessions-agg.inputTokens` **变小**（旧双计消除）、`computeStats.total_input` **变小**——测试对每种聚合用**独立算的期望值**断言，不假设不变。
- **backfill（审查 M3/M4，必须真写路径非自洽夹具）**：用 `insertCompletedEntry` 造 **stage-split** 行（usage 在 outbound_response stage 行）→ 断言 `getEntryById(id).outboundResponse.usage.input_tokens`（detail 路径）**与列 input_tokens 同时**为净值且**二者相等**（防分叉+防 MEDIUM-2 双减，独立 oracle）；**另造 legacy 单 blob 行**测 head-blob 分支；`anthropic-messages` 行断言列+blob 全不变、仅 `usage_normalized=1`；再跑（标记=1）no-op；**清标记再跑演示会二次减**（文档化标记列是唯一防线）；per-entry 坏 blob 失败断言该行保持 `usage_normalized=0` 且下次重试修复（不静默漏改）；cooperative-stop 半途续跑不重算不漏改。
- **展示层**：AgentLane 断言 lane 汇总含 cache；DiagnosticBar/MetaSegment cache 非零渲染；activity-row cacheMiss 判定不变。

---

## 第五部分：接受的局限（审查 M1，如实标注）

`request-telemetry` 是独立 7d 滚动 JSON 存储 + input_tokens **直方图**，**不从 entries_v2 重算**，backfill 不触及。前向修复令所有未来观测正确；已落桶的历史观测无法 re-bucket（直方图本质），随 7d 窗口自然滚出。这是遥测实时性的固有限制，非 backfill 可覆盖，不做（也无法做）retroactive 修正。

---

## Verification

- `bun run typecheck` + `bun run lint:all` 全绿；`bun test` 全绿；`cd ui-v4 && bun run test` 绿。
- backfill 测试用 isolated runtime + sandbox DB（test-isolation skill），跑前证明 sandbox；用真实 `insertCompletedEntry` 写路径造夹具（非手造 blob）。
- **不启动服务器**（no-auto-server-no-kill）；运行时 backfill 行为让用户手动启动观察日志。

## 收尾（session-closeout）

subagent 独立核验 → doc-sync（DESIGN.md 活的架构现状 + history-sqlite-schema skill 加 usage_normalized 列 + 相关记忆）+ 跨文档 grep 验证 → 归档 plan 到 docs/plan → 提炼教训（usage 净值约定 + backfill 破坏性算术须 per-row 标记 + usage 落 outbound_response stage 非 head blob）维护记忆库 → 细粒度阶段提交（原语+生产端 / 展示层 / schema 列+写路径 / backfill / 测试 分开）。

## Commit 顺序约束

同一二进制内 part1（生产端净值）与 part3（backfill）共存，backfill 正确性靠标记列不靠部署序；但建议 commit 序 = schema 列 → 生产端+写路径置标记 → backfill → 展示 → 测试穿插，保证每个中间 commit typecheck 绿、无半坏。

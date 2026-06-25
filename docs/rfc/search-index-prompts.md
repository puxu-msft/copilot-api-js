# Prompts: search_index 内容寻址搜索 —— 每 phase kickoff

> 配 [search-index-plan.md](search-index-plan.md)（HOW + factory-anchor）+ [search-index-delta-forest.md](search-index-delta-forest.md)（WHY + 契约）。每个 prompt **自包含**：控制者按 DAG 顺序贴给 implementer subagent（general-purpose、全量工具）；每 phase 收尾派 spec-review + quality-review subagent。
>
> **每个 prompt 必带的公共头**（控制者粘贴时附上）：
> - **⛔ GIT**：可 `git add -p`/`git commit`（细粒度 pathspec、绝不 `-A`/`.`/`-am`、提交前 `git diff --cached --stat` 复核仅本次改动）；**绝不** push/改写历史/`git checkout` 他人文件/`git stash`。本仓库有并发会话——只提交你本 phase 的精确文件。
> - **裁判轴**：长远正确 + 范围内完整，**不是** ROI/YAGNI/工期/改动量。
> - **bun-first**：`bun run typecheck`、`bun run test:backend`（**非 npm**）；前端 `bun run --filter copilot-api-ui typecheck/test`。不分号、三元行首、严格 TS **无 any**、ESNext。`eslint --fix` 你改的文件（非 `prettier --write`）。
> - **不起服务器**：不 `bun run dev/start`；需验证服务器行为让用户起。
> - 完成报 **DONE/DONE_WITH_CONCERNS/BLOCKED/NEEDS_CONTEXT** + 命令结果 + 改动文件 + 确认零越界。

---

## P0 — Foundation（diff 核 + 归一化）

实现 search_index 搜索的两个纯基建模块，**无 schema、无行为变更**——纯新增 + 单测。

**背景**：项目要把 2.77GB 的 trigram FTS 换成内容寻址消息去重搜索。本 phase 只做两个底层纯函数模块，后续 phase 才接 schema。

**任务**：
1. 新建 `src/lib/diff/block-align.ts`：从**活的前端树 `ui/src/utils/block-diff.ts`** 端口纯 jsdiff 块对齐核（取 `\0` 分隔、`JSON.stringify` 改 **compact** 无 pretty-print——现有是 `JSON.stringify(content,null,2)` pretty）。`import { diffArrays } from "diff"`（`package.json` 已有 `diff@9`、全仓零 import、纯 JS、Bun 原生）。**新写导出** `alignMessages(left: Array<Msg>, right: Array<Msg>): Array<AlignRow>`（AlignRow 含 `kind: 'same'|'added'|'removed'|'modified'` + `left?`/`right?` 文本）——注意现有导出是 `alignWithModified`/`diffMessageList`，名/签名都不同，`alignMessages` 是**新写的**、不是直接搬。**不要 applyPatch**（只需对齐取改动文本）。剥掉前端 `@/types`、用后端 message 形状。**注意**：两副本已分叉（`ui/src/utils/block-diff.ts` 与 `ui-v4/src/lib/diff/block-diff.ts` 不同），活的产品树是 `ui/`——从它端口。**UI re-import 此后端核是独立后续、不进本 phase**（P0 须"纯新增零行为变更"，不碰任何 UI 代码）。
2. 新建 `src/lib/history/normalize-message.ts`：
   - `normalizeMessageForIndex(msg, format): string` —— **config-无关、确定、稳定**（同消息恒同输出）。无条件递归剥 `cache_control`（在 untyped `content[]` + 嵌套 `tool_result.content[]` + 消息级，须显式递归走每层）、`<system-reminder>`/`<ide_opened_file>`/`<ide_diagnostics>` 文本内标签、`ephemeral`。稳定 key 序、`content:undefined→null`。按 `format`（`'anthropic'|'openai'|'gemini'`）分支——Anthropic 是 content-block union，OpenAI/Gemini 是松散 `MessageContent`（`content: string|any[]|null` + `tool_calls`/`role:"tool"`），形状不同不能假设。
   - `hashMessage(msg, format): string` —— SHA-256（`node:crypto`）截 16 字节 → 32 hex。
   - **单一 owner**，文件头契约注释钉死："本归一化投影同时是哈希投影 AND 存储文本投影；剥掉的样板（reminder/cache_control）故意不可搜（噪声）；**绝不复用** config 驱动的 `system-prompt/reminder.ts` 的 `removeSystemReminderTags`（它读 `state.rewriteSystemReminders`、默认 false→不剥→哈希随 config 变）。"
   - **实测易变子串清单**：先从运行中的 4141 `/history/api/entries/:id` 拉真实 Claude Code inbound 消息，枚举哪些子串/字段每轮变（cache_control 位置、system-reminder、ide_opened_file/ide_diagnostics/ide_selection、cwd、turn-counter），确保剥全。手法见 memory `empirical-probe-via-history-api`。**漏一种→该类消息每轮 re-hash、去重退化**——加可观测 tripwire（去重比 `distinct msg_blob/total req_msg` 进 log/history_meta，远低于实测 42.7× 即清单不全）。

**先读**：`ui/src/utils/block-diff.ts`（活树算法核）、`src/lib/history/types.ts`（`HistoryEntry.inboundRequest.messages`、`MessageContent`、content block 形状）、`src/lib/history/in-flight.ts` 的 `extractSearchText`（现有消息文本提取参考，但**别复用**——它含 system/tool 且非归一化）、`src/lib/anthropic/sanitize/{system-reminders,read-tool-result-tags}.ts`（看现有标签剥离逻辑，确认覆盖范围、ide_* 是否漏——实测确认 ide_* 现有函数不覆盖）。

**测试**：`tests/history/normalize-message.unit.test.ts`（4 格式各归一化稳定;同消息含/不含 cache_control → 哈希**相等**〔取真实连续两请求实测,memory 探针〕;ide_*/reminder 剥后稳定;`state.rewriteSystemReminders` 切 true/false → 哈希**不变**〔config-无关〕）;`tests/diff/block-align.unit.test.ts`（added/removed/modified 对齐;`\0` 不误连相邻消息）。

**commit invariant**：纯新增模块 + 单测;typecheck/test:backend 全绿;零现有行为变更。

---

## P1 — Schema + 双写（C1）

建 search_index 表/列;finalize **同时**写旧 `search_text`（FTS 仍服务）+ 新索引;搜索读路径**不变**。P0 的 `normalize-message.ts`/`block-align.ts` 已就绪。

**任务**：
1. `src/lib/history/sqlite/schema.ts` `SCHEMA_SQL` 加 `msg_blob(hash PK, text)`/`req_msg(req_id,pos,hash, PK(req_id,pos), FK→entries_v2 ON DELETE CASCADE)`/`req_aux(req_id,source,text, PK(req_id,source), FK CASCADE)`/`history_meta(key PK, value)` + `idx_req_msg_hash`/`idx_req_aux_src`。**FTS_SCHEMA_SQL 不动**。
2. `connection.ts` `openDatabase` 在 SCHEMA_SQL 后建新表（IF NOT EXISTS）;`migrateEntriesColumns` `wanted` 数组**加** `{name:"prev_req_id", type:"TEXT"}`（**别动 search_text 行**——P3 才删）。
3. 新建 `src/lib/history/sqlite/search-index-write.ts`：
   - `buildSearchIndexForEntry(entry): SearchIndexBuilt`（**纯函数、事务外**）：normalize+hash 每条 inbound 消息（`normalizeMessageForIndex`/`hashMessage`，format 从 `entry.endpoint` 推）;`alignMessages` 算 rewrites-req（`diff(inbound, outbound_request)`）+ rewrites-resp（**按 transport 拆**:流式 diff `sseEvents`↔`inboundResponse.sseEvents`、非流式 diff `outboundResponse.content`↔归一化的 `inboundResponse.content`;`inboundResponse` 缺→该源空），取 `added∪removed∪modified 两侧`文本;拼 headers（`key: value` 行、leg/条目间 `\x1e`）。
   - `persistSearchIndex(db, reqId, built)`（**事务内**）：`INSERT OR IGNORE msg_blob`+`INSERT req_msg`+`INSERT req_aux`+UPDATE `prev_req_id`（= `SELECT id FROM entries_v2 WHERE session_id=? AND agent_id IS ? AND started_at<? ORDER BY started_at DESC LIMIT 1`，O(1)、无前缀校验）。
4. `write.ts` `insertCompletedEntry` 事务内**追加**调 `persistSearchIndex`（与 head/stage 原子;built 事务外先算传入）;`search_text` 仍写（双写）。

**先读**：`src/lib/history/sqlite/{schema.ts,connection.ts,write.ts(insertCompletedEntry tx + INSERT_ENTRY_SQL),serialize.ts(EntryRow)}`、P0 的两模块。

**测试**：`tests/history/search-index-write.it.test.ts`（`useIsolatedRuntime()`;finalize 后 msg_blob 同消息单行去重、req_msg 映射 pos 序、req_aux 各源含 removed、prev_req_id 组内最近、事务原子）。

**commit invariant**：新 entry 双写、旧读全绿、搜索行为零变化（仍 FTS）。

---

## P2 — Backfill（可恢复）+ read 切换（C2）

历史建索引 + 重算 preview;新搜索端点;read 切 search_index（gated 完成标志、FTS 兜底）;列表 preview 快筛;in-flight 内存扫。

**任务**：
1. `preview-backfill.ts` → **改名** `search-index-backfill.ts`;`backfillPreviewInBackground`→`startSearchIndexBackfill`。**可恢复 + 优雅中途退出（生命周期关键）**：按 (session,agent)+started_at 序逐条;每条 `SELECT 1 FROM req_msg WHERE req_id=?` 跳已建;游标 `history_meta('search_index_backfill_cursor',<started_at>)` 每批更新;**协作式 stop——绝不订阅 `getShutdownSignal()`**（它是 Phase 3、而 `shutdownHistory()` Phase 1 就 `closeDatabase()`、loop 下条 prepare 会抛在已关 DB）:新增 `stopSearchIndexBackfill()`（置 flag），`state.ts` 的 `shutdownHistory` 在 `closeDatabase` **之前**调它 + await 当前批落库,loop 每批查 flag 命中即存游标后退出;硬关兜底=每批已存游标重启续;**完成标志 `history_meta('search_index_version','1')` 只全跑完置**;guard run-iff-≠'1'、**绝不读 user_version**;每条重算 `preview_text`（吸收 preview-backfill、首跑全量）+ `buildSearchIndexForEntry`/`persistSearchIndex`;多腿解压（inbound/outbound_request 在 request_group 帧、outbound_response/inbound_response 响应腿、headers——读 `serialize.ts` 的 stage/request_group 解码）;batch-per-entry tx + 周期 `wal_checkpoint`。
2. `state.ts:{25 import,107 def,109 call}`/`store.ts:27`/`index.ts:36`/`start.ts:{35 import,543 调用}`：`startPreviewBackfill`→`startSearchIndexBackfill`;**backfill 现有状态（stop flag/游标 handle）须给 `reset*ForTests` 并登记 RESETTERS**（现有 startPreviewBackfill 无 resetter、是新增——L1 守卫 `resetters-complete.unit` 会抓漏）。
3. 新建 `src/lib/history/sqlite/search-query.ts`：`searchInbound(db,needle,filters,page)`（`msg_blob.text LIKE`〔`escapeLikeNeedle`+`ESCAPE '\'`〕→hash→`req_msg`→每 hash 一行 `SearchResultRow{hash, ownerReqId:min(started_at), snippet, summary:EntrySummary}`;**snippet = JS 对 `msg_blob.text` `indexOf(needle)` 取居中窗口**〔LIKE 只给存在性、偏移须 JS 算〕;**`containingReqIds` 不内联**〔可达数百〕;结构化过滤解析后 AND;**分页 cursor=`(min_started_at,hash)` 复合键**〔抗 reaper 漂移〕）;`searchAux(db,source,needle,…)`。
4. 新搜索 REST：`src/routes/history/handler.ts` 加 `GET /api/search?source=&q=&limit=&cursor=`（5 源单选切换）+ `GET /api/search/contains?hash=`（懒取 containingReqIds）+ `route.ts` 注册 + OpenAPI;新类型 `SearchResultRow`（`types.ts`）。**完成标志前 inbound 结果部分**→返 `{partial:true, builtPct}`。
5. `read.ts` `applyWhere` 的列表 `?search=`：改**只 `preview_text LIKE`**（删 FTS MATCH 分支/`FTS_MIN_NEEDLE`/`ftsLiteral`/`search_text LIKE` 项）。**注意（reviewer C2）：这是列表搜索的即时、无条件降级为 preview-only**——**无 FTS 兜底**（FTS read 切换后即无人读、P3 删）。"gated 完成标志" 只对**新 `/api/search` 端点的 inbound 源**（未建完返 partial），不对列表。
6. `queries.ts:{54-58}` in-flight `summaryMatchesFilters`：改**内存扫 `entry.inboundRequest.messages` 归一化文本**（用 P0 提取器、同投影）;`getHistorySummaries` merge/dedup by id。

**先读**：`preview-backfill.ts`（可恢复后台模式）、`src/lib/shutdown.ts`（abort signal）、`read.ts(applyWhere/querySummaries)`、`queries.ts`、`routes/history/{handler,route}.ts`、`serialize.ts`（多腿解码）。

**测试**：`tests/history/search-index-backfill.it.test.ts`（建索引+重算 preview;**中途 abort→游标续、不重头不漏不重**;完成标志只全跑完置;`user_version=1` 库仍跑）;`tests/history/search-query.it.test.ts`（inbound owner 去重=消除 previous、rewrites/headers、CJK 2 字、`%/_` ESCAPE、过滤组合、分页、列表 preview vs 专门页全文）。

**commit invariant**：搜索可用（新路径 for 已建、FTS for 未建）;backfill 可恢复;旧 search_text 仍在。

---

## P3 — 弃 FTS + 删 search_text 列 + GC（C3）

原子 DROP;写路径列引用**同 commit**全清;EntrySummary.searchText 删 + 全消费者;门控 GC;终态单一路径。**这是最易半坏的 phase——漏一处 search_text 写引用，DROP 后 finalize 即炸。**

**任务（同一 commit 内完成 DROP + 全部列引用清理）**：
1. `connection.ts` `openDatabase` 内、**`reclaimOrphanedActiveRows` 调用（line ~82；函数定义在 251、它 UPDATE entries_v2 触发 fts_au）之前**加原子 `db.transaction`：`DROP TRIGGER entries_v2_fts_ai/ad/au` → `DROP TABLE IF EXISTS entries_fts` → `ALTER TABLE entries_v2 DROP COLUMN search_text`（**严格此序**——实测列被触发器引用时 DROP COLUMN 抛 "no such column"）;never-throw 包裹 + 后 `PRAGMA table_info` 验真删（防 BUSY 静默残留）。删 `ensureSearchIndex`/`rebuildSearchIndexIfPresent` 函数+调用、`FTS_SCHEMA_SQL` import、`maybeVacuumOnStartup` 内 rebuild 调用。**`migrateEntriesColumns` `wanted` 删 `{name:"search_text"}`（line 293——否则下次开库 ADD 回、列复活!）** + 更新 273/277 docblock 注释（提 search_text 处）。
2. `schema.ts` 删 `FTS_SCHEMA_SQL`。
3. **写路径列引用全清（同 commit，漏=finalize 炸）**：`serialize.ts` `EntryRow` 删 `search_text`（~37）+ `serializeHeadEntry` 删 `search_text: extractSearchText(entry)`（~230）;`write.ts` `INSERT_ENTRY_SQL` 删 search_text 列（~28）/ON CONFLICT（~41）/bind（~75）;`read.ts` `querySummaries` SELECT 删 search_text（~144）/`rowToSummary` 删 `searchText`（~192）/`?search=` 旧 `search_text LIKE` 项（~107，P2 应已改、确认）。
4. 删 `in-flight.ts` `extractSearchText`（137-176）;`summaryTextCache`/`getCachedSummaryText` 改只缓 preview（22-33）;`toEntrySummary` 删 `searchText`（213）。
5. `types.ts` `EntrySummary` 删 `searchText` 字段。
6. **孤儿 msg_blob GC 接全部 3 个删除点（reviewer C3，漏则 clearAll 后 msg_blob 全成永久死空间）**：① `reaper.ts` `runReaperTick`/`evictBucket` 后**门控**（仅本 tick `deleted>0`）同步单语句 `DELETE FROM msg_blob WHERE NOT EXISTS(SELECT 1 FROM req_msg WHERE req_msg.hash=msg_blob.hash)`;② `write.ts` `deleteSession` 删除事务内同 GC 语句;③ `write.ts` `clearAllEntries` 直接 `DELETE FROM msg_blob`+`DELETE FROM req_aux`（全清无需 NOT EXISTS）。计数 `SELECT COUNT`（非 .changes）。
7. **前端**：`ui/src/pages/vuetify/VActivityPage.vue:137` + 6 测试文件（`ui/tests/store.test.ts:{366,378}`、`activity-helpers.test.ts:24`、`vitest/{activity-row:15,activity-navigation:37,47,detail-page:46-48}`、`tests/e2e-ui/history-mocks.ts:{67,94}`）删 `searchText` 字面量（`satisfies EntrySummary` 含它会 TS2353）。
8. 测试改/删：`preview-backfill.it`→已改名（P2）、`search-fts.unit`/`search-backfill.it` 重写或删、`in-flight-summary-memo.unit`（extractSearchText 删）、`history-ws.unit:51`、`history-summary.it:{5,387,643}`（全文体搜断言改走专门页 `searchInbound`）、`serialize.unit:121`、`history-store.it:570`。

**先读**：上述每个 `file:line`;`grep -rn search_text src` + `grep -rn searchText src ui tests` 自查枚举完整（漏一处即半坏）。

**测试**：finalize（含 eager+完成）不再引用 search_text;DROP 后 `PRAGMA table_info(entries_v2)` 无 search_text;重开库不复活;GC 门控（无淘汰不扫、孤儿扫除、非孤儿留）;全 `tests/history/**` 绿;前端 `bun run --filter copilot-api-ui typecheck/test` 绿。

**commit invariant**：单一路径、无 FTS、列真删（table_info 验 + wanted 删）、finalize 工作、GC 工作、前后端全绿。

---

## P4 — VACUUM + doc-sync（C4）

**任务**：
1. 验证下次开库 `maybeVacuumOnStartup` 回收 2.77G FTS + search_text 列空间（freelist≫25% 阈值触发）——确认触发、无需新代码;必要时 `exp/` 实测大库副本。
2. `docs/DESIGN.md` history 行更新（FTS→search_index 内容寻址 + 归一化 + 门控 GC + prev_req_id 解耦待线程化）;`docs/history.md` 相关;**RFC 文件重命名** `search-index-delta-forest.md`→`search-index-content-addressed.md` + plan/prompts 交叉引用更新。
3. 验收：全套件绿;backfill 可恢复 + VACUUM 回收实测背书;memory 提炼（内容寻址搜索/归一化哈希/可恢复 backfill 教训）。

**commit invariant**：文档与代码同步、RFC 名正、实测背书。

---

## 收尾（全 phase 后）

整体 review subagent（spec 合规 + 质量 + 安全）跨全 5 phase;确认 commit invariants 链成立（每中间 commit 系统可用）;doc-sync 完成（[[feedback-completion-updates-docs]]:DESIGN/history/memory 回填、旧状态词清零、`grep` 扫描验证）。

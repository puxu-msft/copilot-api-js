# Plan: search_index 内容寻址搜索 —— 实现交接稿

> 配 [search-index-delta-forest.md](search-index-delta-forest.md)（RFC v4，设计/WHY/契约）。本文是 **HOW**：phase DAG + factory-anchor 表（精确文件/函数/符号增删改）+ 命名常量 + 每 phase commit invariant + 验收。执行用 subagent-driven-development（每 phase 一 implementer + spec/quality review）。
> 硬约束贯穿全程：bun-first（`bun run typecheck`/`test:backend`，非 npm）、不分号、严格 TS 无 any、`eslint --fix`、细粒度 pathspec 提交、subagent 全量工具 + 显式裁判轴（长远正确+完整，非 ROI）。

## Phase DAG

```
P0 foundation (diff 核 + 归一化, 无 schema/行为变更)
      │
P1 schema + 双写 (C1: msg_blob/req_msg/req_aux/history_meta + prev_req_id; finalize 建索引; 搜索仍 FTS)
      │
P2 backfill + read 切换 (C2: 可恢复后台 backfill; 新搜索端点; read 走 search_index gated; 列表 preview 快筛; in-flight 内存扫)
      │
P3 弃 FTS + 删 search_text 列 + GC (C3: 原子 DROP; 写路径列清; EntrySummary.searchText 删; 全消费者枚举; 门控 GC)
      │
P4 VACUUM + doc-sync (C4: 回收; DESIGN/history 文档; RFC 重命名; 全套件绿)
```

每 phase = 一个 commit（或一阶段多 commit，每个自洽）；**每个中间 commit 不让系统半坏**（[[methodology-commit-invariants]]）。

## 命名常量（钉死，跨 phase 引用）

| 常量/符号 | 值/位置 | 说明 |
|---|---|---|
| `SEARCH_INDEX_VERSION` | `'1'` | `history_meta('search_index_version', …)` 完成标志；guard run-iff-≠ |
| `SEARCH_BACKFILL_CURSOR` | `history_meta('search_index_backfill_cursor', <started_at>)` | 可恢复进度游标 |
| `MSG_HASH_BYTES` | 16（SHA-256 截 128bit → 32 hex） | msg_blob.hash 宽度 |
| `HEADER_SEP` | `'\x1e'` | req_aux headers 隔断符 |
| 归一化 owner | `src/lib/history/normalize-message.ts` 的 `normalizeMessageForIndex(msg, format)` | config-无关、跨 4 格式、唯一投影（哈希=存储文本） |
| diff 核 | `src/lib/diff/block-align.ts`（**新建**；从**活树** `ui/src/utils/block-diff.ts` 端口算法核〔非 `ui-v4/`，两副本已分叉；`ui-v4` 的也有 `\0` 变体可参〕；**`alignMessages` 是新写的导出**〔现有是 `alignWithModified`/`diffMessageList`，名/签名都新〕；**compact stringify 新写**〔现有 `messageText` 是 pretty-print〕） | rewrites 改动文本 |
| backfill stop | `stopSearchIndexBackfill()`（新增；`shutdownHistory` 在 `closeDatabase` 前调，协作式 cancel——**非** `getShutdownSignal()` 订阅，那是 Phase 3、DB 已 Phase 1 关） | 优雅中途退出 |
| 结果类型 | `SearchResultRow = {hash, ownerReqId, snippet, summary}`；`containingReqIds` 走独立懒端点 `/search/contains?hash=`；分页 cursor=`(min_started_at,hash)` | 专门页 5 源切换 |
| 源枚举 | `type SearchSource = 'inbound'|'rewrites-req'|'rewrites-resp'|'req-headers'|'resp-headers'` | search_index.req_aux.source + 端点 facet |

## P0 — Foundation（diff 核 + 归一化；无 schema/行为变更）

**目标**：纯新模块 + 单测，其余全绿、零行为变更。

| 动作 | 文件 · 符号 |
|---|---|
| 新建 | `src/lib/diff/block-align.ts` —— **从活树 `ui/src/utils/block-diff.ts` 端口**纯 jsdiff 块对齐核（`\0` 分隔、**compact** stringify〔现有是 `JSON.stringify(...,2)` pretty，须改 compact〕），`import { diffArrays } from "diff"`（package.json 已有 `diff@9`、零 import、纯 JS Bun 原生）。**新写导出** `alignMessages(left, right)`→对齐行（含 `added`/`removed`/`modified.left/right`；现有名是 `alignWithModified`/`diffMessageList`、签名不同、`alignMessages` 是新的）；不含 applyPatch。**UI re-import 此核是独立后续、不进 P0**（P0 须"纯新增零行为变更"，不碰 UI） |
| 新建 | `src/lib/history/normalize-message.ts` —— `normalizeMessageForIndex(msg, format): string`（config-无关无条件剥 `cache_control`〔untyped `content[]`+嵌套 `tool_result.content[]`+消息级，递归走〕、`<system-reminder>`/`<ide_opened_file>`/`<ide_diagnostics>` 文本标签、`ephemeral`；稳定 key 序；`content:undefined→null`；按 `format` 分支 Anthropic vs OpenAI/Gemini 形状）。`hashMessage(msg, format): string`（SHA-256 截 `MSG_HASH_BYTES`）。**单一 owner**，契约注释钉死"归一化即哈希投影即存储文本" |
| **不复用** | `removeSystemReminderTags`（`system-prompt/reminder.ts` 读 `state.rewriteSystemReminders` config）——P0 的剥离须无条件、独立实现 |
| 测试 | `tests/history/normalize-message.unit.test.ts`（4 格式归一化稳定;同消息含/不含 cache_control 哈希相等;ide_*/reminder 剥除;config 切换不改哈希）、`tests/diff/block-align.unit.test.ts`（added/removed/modified 对齐;\0 分隔不误连） |

**commit invariant**：纯新增 + 单测，typecheck/test:backend 全绿、零现有行为变更。

## P1 — Schema + 双写（C1）

**目标**：新表/列建好;finalize **同时**写旧 search_text（FTS 仍服务）+ 新 search_index;搜索读路径**不变**。

| 动作 | 文件 · 符号 |
|---|---|
| 改 | `src/lib/history/sqlite/schema.ts` —— `SCHEMA_SQL` 加 `msg_blob`/`req_msg`/`req_aux`/`history_meta` 表 + 索引（见 RFC schema）。FTS_SCHEMA_SQL **不动**（P3 才删） |
| 改 | `connection.ts` —— `openDatabase` 在 SCHEMA_SQL 后建新表（IF NOT EXISTS）;`migrateEntriesColumns` `wanted` 数组**加** `{name:"prev_req_id", type:"TEXT"}`（**注意 P3 会从此数组删 search_text，本 phase 不动 search_text 行**） |
| 新建 | `src/lib/history/sqlite/search-index-write.ts` —— `buildSearchIndexForEntry(entry): { msgs: Array<{pos,hash,text}>, aux: Array<{source,text}>, prevReqId: string|null }`（**事务外**算:normalize+hash inbound 消息、`alignMessages` 算 rewrites-req/resp〔按 transport 拆〕改动文本〔added∪removed∪modified〕、拼 headers〔`HEADER_SEP`〕）;`persistSearchIndex(db, reqId, built)`（**事务内** `INSERT OR IGNORE msg_blob`+`INSERT req_msg`+`INSERT req_aux`+UPDATE prev_req_id;prevReqId 查"组内时间最近一条"O(1)） |
| 改 | `write.ts` —— `insertCompletedEntry` 事务内**追加**调 `persistSearchIndex`（与 head/stage 原子）;built 在事务外先算好传入。search_text 仍写（双写） |
| 测试 | `tests/history/search-index-write.it.test.ts`（finalize 后 msg_blob 去重〔同消息单行〕、req_msg 映射、req_aux 各源、prev_req_id 组内最近;rewrites 含 removed;事务原子） |

**commit invariant**：新 entry 双写、旧 entry 旧读全绿、搜索行为零变化（仍 FTS）。

## P2 — Backfill（可恢复）+ read 切换（C2）

**目标**：历史建索引 + 重算 preview;新搜索端点;read 切 search_index（gated 完成标志、FTS 兜底）;列表 preview 快筛;in-flight 内存扫。

| 动作 | 文件 · 符号 |
|---|---|
| 改/并 | `preview-backfill.ts` → **改名** `search-index-backfill.ts`，`backfillPreviewInBackground`→`startSearchIndexBackfill`/`runSearchIndexBackfill`。**可恢复**:按 (session,agent)+started_at 序逐条;每条 `SELECT 1 FROM req_msg WHERE req_id=?` 跳过已建;游标 `SEARCH_BACKFILL_CURSOR` 每批更新;响应 shutdown abort（接 `lib/shutdown` signal）中途 checkpoint 退出;**完成标志只全跑完置 `SEARCH_INDEX_VERSION`**;guard run-iff-≠、**绝不读 user_version**;重算 preview_text + 调 `buildSearchIndexForEntry`/`persistSearchIndex`;多腿解压（inbound/outbound_request request_group 帧 + outbound_response/inbound_response 响应腿 + headers）;batch-per-entry tx + 周期 WAL checkpoint |
| 改 | `state.ts:{25,107}`/`store.ts:27`/`index.ts:36`/`start.ts:{35,543}` —— `startPreviewBackfill`→`startSearchIndexBackfill`（含 import 行;RESETTERS 登记同步） |
| 新建 | `src/lib/history/sqlite/search-query.ts` —— `searchInbound(db, needle, filters, page)`（`msg_blob LIKE`→hash→`req_msg`→每 hash 一行 `{hash, ownerReqId:min(started_at), snippet, summary, containingReqIds}`;结构化过滤解析后 AND;`escapeLikeNeedle`+`ESCAPE '\'`）、`searchAux(db, source, needle, …)` |
| 新建 | `src/routes/history/` —— `GET /api/search?source=&q=&limit=&cursor=` handler（`handler.ts` 加 + `route.ts` 注册）;新结果类型 `SearchResultRow`（types.ts）。OpenAPI 注册 |
| 改 | `read.ts` —— `applyWhere` 的 `?search=`（列表内联）改**只 `preview_text LIKE`**（删 FTS MATCH 分支、`FTS_MIN_NEEDLE`、`ftsLiteral`、`search_text LIKE` 项——P3 删列前先停用）;read 切换 **gated** 在 `SEARCH_INDEX_VERSION` 完成标志（未完成→旧 FTS 兜底） |
| 改 | `queries.ts:{54-58}` —— in-flight `summaryMatchesFilters` 改**内存扫 `entry.inboundRequest.messages` 归一化文本**（保留消息文本提取器、与持久同投影）;`getHistorySummaries` merge/dedup by id |
| 测试 | `tests/history/search-index-backfill.it.test.ts`（建索引+重算 preview;**中途 abort→游标续、不重头不漏不重**;完成标志只全跑完置;user_version=1 库仍跑）、`tests/history/search-query.it.test.ts`（inbound owner 去重=消除 previous;rewrites/headers;CJK 2 字;%/_ ESCAPE;过滤组合;分页） |

**commit invariant**：搜索可用（新路径 for 已建、FTS for 未建）;backfill 可恢复;列表/专门页两路;旧 search_text 仍在（P3 才删）。

## P3 — 弃 FTS + 删 search_text 列 + GC（C3）

**目标**：原子 DROP;写路径列引用全清（同 commit）;EntrySummary.searchText 删 + 全消费者;门控 GC;终态单一路径。

| 动作 | 文件 · 符号 |
|---|---|
| 改 | `connection.ts` —— `openDatabase` 内、**`reclaimOrphanedActiveRows` 调用（line ~82；函数定义在 251）之前**加原子 tx:`DROP TRIGGER entries_v2_fts_ai/ad/au → DROP TABLE entries_fts → ALTER TABLE entries_v2 DROP COLUMN search_text`;never-throw + 后 `PRAGMA table_info` 验真删。删 `ensureSearchIndex`/`rebuildSearchIndexIfPresent`/`FTS_SCHEMA_SQL` import/调用 + `maybeVacuumOnStartup` 内 rebuild 调用。**`migrateEntriesColumns` `wanted` 删 `{name:"search_text"}`（line 293，否则下次开库列复活）** + 更新 273 注释（提 search_text 处） |
| 改 | `schema.ts` —— 删 `FTS_SCHEMA_SQL` |
| 改 | `serialize.ts` —— `EntryRow` 删 `search_text`（~37）;`serializeHeadEntry` 删 `search_text: extractSearchText(entry)`（~230） |
| 改 | `write.ts` —— `INSERT_ENTRY_SQL` 删 search_text 列（~28）+ON CONFLICT（~41）+bind（~75） |
| 改 | `read.ts` —— `querySummaries` SELECT 删 search_text（~144）+`rowToSummary` 删 `searchText`（~192） |
| 删 | `in-flight.ts` —— `extractSearchText`（137-176）;`summaryTextCache`/`getCachedSummaryText` 改只缓 preview（22-33）;`toEntrySummary` 删 `searchText`（213） |
| 改 | `types.ts` —— `EntrySummary` 删 `searchText` 字段（~458） |
| 改 | **孤儿 msg_blob GC 接全部 3 个删除点（reviewer C3，漏则 clearAll 后 msg_blob 全成死空间）**:① `reaper.ts` `runReaperTick`/`evictBucket` 后**门控**（仅 `deleted>0`）同步单语句 `DELETE FROM msg_blob WHERE NOT EXISTS(SELECT 1 FROM req_msg WHERE req_msg.hash=msg_blob.hash)`;② `write.ts` `deleteSession` 删除事务内同 GC 语句;③ `write.ts` `clearAllEntries` 直接 `DELETE FROM msg_blob`+`DELETE FROM req_aux`（全清无需 NOT EXISTS）。计数 `SELECT COUNT`（非 .changes） |
| 改前端 | `VActivityPage.vue:137` + 6 测试文件（`ui/tests/store.test.ts:{366,378}`/`activity-helpers.test.ts:24`/`vitest/{activity-row:15,activity-navigation:37,47,detail-page:46-48}`/`e2e-ui/history-mocks.ts:{67,94}`）删 `searchText` 字面量 |
| 测试改 | `preview-backfill.it`→改名、`search-fts.unit`/`search-backfill.it` 重写/删、`in-flight-summary-memo.unit`（extractSearchText 删）、`history-ws.unit:51`、`history-summary.it:{5,387,643}`（全文体搜断言改走专门页）、`serialize.unit:121`、`history-store.it:570` |

**commit invariant**：finalize 不再引用 search_text（DROP 前同 commit 清）;单一路径;无 FTS;列真删（table_info 验 + wanted 删防复活）;GC 工作;全套件绿。

## P4 — VACUUM + doc-sync（C4）

| 动作 | 文件 |
|---|---|
| 验证 | 下次开库 `maybeVacuumOnStartup` 回收 2.77G FTS + search_text 列（freelist≫25%）;无需新代码、确认触发 |
| doc | `docs/DESIGN.md` history 行（FTS→search_index 内容寻址、归一化、GC、prev_req_id 解耦）;`docs/history.md`/`streaming` 相关;RFC 文件 **重命名** `search-index-content-addressed.md` + 更新交叉引用 |
| 验收 | 全套件绿;`exp/` 实测大库 backfill 可恢复 + VACUUM 回收 |

**commit invariant**：文档与代码同步;RFC 名正;实测背书。

## 验收/测试矩阵（贯穿）

- **归一化**:4 格式稳定 + cache_control/ide_*/reminder 剥除 + config-无关（P0）。
- **去重**:同消息单 msg_blob、42.7× 量级（P1/P2）。
- **搜索**:owner 去重=消除 previous、rewrites 含 removed、CJK 2 字子串、跨边界 miss 锁、ESCAPE、列表 preview vs 专门页全文（P2）。
- **可恢复 backfill**:中途 abort 续跑、完成标志、user_version=1 库（P2）。
- **DROP 安全**:触发器→表→列序、wanted 删防复活、table_info 验、写路径同 commit（P3）。
- **GC**:门控、无竞态、孤儿扫除（P3）。
- **回收**:VACUUM（P4）。
- 每 phase 收尾 subagent spec+quality review;golden 预捕获（含 CJK、跨边界已知 miss）。

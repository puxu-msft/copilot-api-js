# RFC: search_index —— 内容寻址消息去重搜索（删 search_text + 弃 trigram FTS）

> Status: **已实现**（P1-P4 全落地，2026-06；commits 501bf9a P1 schema+双写 / 6fa2ee8 P2 可恢复 backfill+/api/search+列表 preview / 64ed8f4 P3 弃 FTS+删 search_text 列+孤儿 GC / P4 doc-sync）。已从 `search-index-delta-forest.md` 重命名（`delta-forest` 是 misnomer——内容寻址、非 delta）。落地态见 [history.md「内容寻址搜索」](../history.md) + [DESIGN.md history 行](../DESIGN.md)。实现交接稿见 [search-index-plan.md](search-index-plan.md) + [search-index-prompts.md](search-index-prompts.md)。**取代** v2 delta 森林、[search-text-slim-drop-fts.md](search-text-slim-drop-fts.md)。
> v5：v4+plan+prompts 经**独立对抗 review 核验**（v4 曾自宣收敛未审），修 3 个 CRITICAL（backfill-shutdown 生命周期、列表 vs 专门页两读路径混淆、GC 漏 deleteSession/clearAll 删除点）+ 2 anchor 幻觉（plan/prompts）+ operator 收尾两取舍（A 专门页 5 源可切换、B prev_req_id 现在建）。
> v4：吸收 round-1/2/3 全部 review（含两次实测：归一化哈希必要性、77,128 消息/642 请求/42.7× 去重比/req_msg ~13MB、DROP COLUMN 抛错）+ operator 全决策。scoped 到 entries_v2、优先先做、消除 v3-storage 两个 FTS 紧耦合不变量。
> 触发：v3 调查实测 3.5G 库 79% 是 trigram FTS 索引（2.77GB），根因 = `search_text` 存每条 entry 完整累积对话（~400KB/条）× trigram 10× 放大、且累积低质。

## 决策记录（operator 经多轮对话定）

1. **删 `search_text` 列 + 彻底弃 trigram FTS**（preview_text 留作列表展示）。
2. **去重单元 = 消息（内容寻址 git-blob 式），非请求 delta 链**：搜索几乎总在单条消息内 → 消息是原子单元。每条 distinct 归一化消息按哈希只存一次，请求存"引用哪些哈希"。等效去重、**砍掉前缀匹配/delta 链/splice 三大复杂+危险源**（round-2 CRITICAL splice 触发器未定义行为 → 换引用计数 GC）。实测 42.7× 去重、req_msg ~13MB（对 2.77GB FTS 是零头）。
3. **搜索只靠内容寻址 + owner，`prev_req_id` 与搜索完全解耦**（operator 定）：`prev_req_id` 保留为**廉价 best-effort 列、仅供将来对话线程化**，**绝不进搜索路径**。**v5（取舍B）：operator 为长远正确放宽 YAGNI、现在就建**——但去掉昂贵自引用 FK 级联 + 每次 finalize 前缀比对（reviewer HIGH-4/5）：只取"组内时间最近一条"（真 O(1)、无前缀校验）、**无 FK**（悬挂引用无害、线程 UI 优雅处理）、**计算放 finalize 事务外**（与 build 同步，不进热写锁，reviewer M2）。
4. **源集 = 5 单选 facet**：`inbound`（消息·内容寻址）/ `rewrites-req` / `rewrites-resp` / `req-headers` / `resp-headers`（后四 flat per-request）。不含 outbound（响应正文在下轮 inbound；搜索主场景"结果不对倒查"重改写/headers）。**inbound 只索引 messages blocks 文本、绝不含 system prompt**。
5. **专门搜索页（深，**5 源单选可切换**，按下才搜）+ 列表内联 preview 快筛（轻，as-you-type）分离**：**v5（取舍A）：专门页是 5 个源的单选切换器**（inbound/rewrites-req/rewrites-resp/req-headers/resp-headers，"有的放矢"），**不是只有 inbound**；列表框**只 preview 快筛**。system prompt 全文 / outbound 响应全文是**有意排除**（非 reviewer 误判的"意外缩减"）——搜索为"结果不对倒查"、不搜样板 system，响应正文在下轮 inbound + rewrites-resp diff 覆盖。
6. **结果 = 每命中消息一行（owner=`min(started_at)` 首现请求 + snippet）**；"所有包含该消息的请求"作按需展开。**owner 去重即实现"消除 previous"**（同一消息在 N 请求重复 → 一行），不依赖 prev_id。
7. **rewrites delta = 含 removed 侧**（added ∪ removed ∪ modified 两侧——本项目改写以删/降级为主，"找代理删了哪条 thinking/工具"高价值）。
8. **存归一化文本**（与哈希同投影；剥 cache_control/system-reminder 等样板 → 样板不可搜、是噪声）。
9. **OQ1 = LIKE 零索引**（去重后小、专门页延迟宽松；中文实测:词 tokenizer 对 CJK 废、trigram 2 字词仍兜底、LIKE 对 CJK 子串原生完美）。

## schema

```sql
CREATE TABLE msg_blob (
  hash TEXT PRIMARY KEY,        -- 归一化内容哈希 SHA-256 截 128bit（碰撞→IGNORE 取首写者文本，git 式 content-defined 不变量）
  text TEXT NOT NULL            -- 归一化消息文本（仅 messages blocks、无 system）
);
CREATE TABLE req_msg (
  req_id TEXT NOT NULL, pos INTEGER NOT NULL, hash TEXT NOT NULL,
  PRIMARY KEY (req_id, pos),
  FOREIGN KEY (req_id) REFERENCES entries_v2(id) ON DELETE CASCADE
);
CREATE INDEX idx_req_msg_hash ON req_msg(hash);     -- 搜索 hash→请求 + GC NOT EXISTS 探测
CREATE TABLE req_aux (
  req_id TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL,
  PRIMARY KEY (req_id, source),
  FOREIGN KEY (req_id) REFERENCES entries_v2(id) ON DELETE CASCADE
);
CREATE INDEX idx_req_aux_src ON req_aux(source);
ALTER TABLE entries_v2 ADD COLUMN prev_req_id TEXT;  -- best-effort 血缘、无 FK、不进搜索
CREATE TABLE history_meta(key TEXT PRIMARY KEY, value TEXT);  -- 迁移 guard + backfill 进度游标
```

## 归一化（强制；round-3 CRITICAL-1/2/3 修正）

**专用无条件归一化函数，单一 owner 在 `src/lib/history/`**，**绝不复用 config 驱动的 sanitize 路径**（`removeSystemReminderTags` 读 `state.rewriteSystemReminders`、默认 false→不剥→哈希随 config 变 + 跨运行不稳）。要求：
- **config-无关、确定、稳定**（同消息→恒同哈希）。
- **跨 4 格式**：inbound 在 4 格式都存 `inboundRequest.messages`，但形状不同（Anthropic content-block union vs OpenAI/Gemini 的 `MessageContent` 松散形）→ 按格式分支归一化，不能假设 Anthropic 形状。
- **递归剥 per-turn 易变内容**：`cache_control`（在 untyped `content[]` + 嵌套 `tool_result.content[]` + 消息级，须显式递归走）、`<system-reminder>`/`<ide_opened_file>`/`<ide_diagnostics>` 文本内标签（实测 sanitize 现有函数**不覆盖** ide_* → 须补全易变子串清单）、`ephemeral` 等。稳定 key 序、`content:undefined→null`。SHA-256 截 128bit。
- **同投影用于哈希 AND 存储文本**（决策8）→ 样板不可搜（噪声）。**实测必要**：CC 每轮前移 cache_control 断点 → 不归一化则同消息每轮哈希变（raw 643/645 vs 归一化 645/645）→ 去重失效。**实测点须用 history 存储后的消息形状**（cache_control 经 `any`-typed content round-trip，非 live sanitize 输入）。

## 5 源构建（finalize 时；jsdiff 出事务 round-3 MEDIUM-3）

`insertCompletedEntry` **事务外**先算好所有派生文本（normalize 消息、SHA-256、jsdiff rewrites、prev_req_id 查询——CPU/读密集不持写锁），**事务内**只 bind 写入。**build 降级（reviewer M1）**：`buildSearchIndexForEntry` 整体包 try/catch——任一格式畸形消息/意外形状致 build 抛时，**该 entry 索引置空但绝不阻断 head/stage finalize**（搜索是派生、finalize 健壮性优先）。
- **inbound**：每条归一化消息 → `INSERT OR IGNORE msg_blob(hash,text)` + `INSERT req_msg(req_id,pos,hash)`。
- **prev_req_id（事务外查，reviewer M2）**：组内时间最近一条（`SELECT id FROM entries_v2 WHERE session_id=? AND agent_id IS ? AND started_at<? ORDER BY started_at DESC LIMIT 1`，走 `idx_entries_v2_session_agent`、真 O(1)、无前缀校验）；在 build 步查好、事务内只 UPDATE 一列。
- **rewrites-req**：`diff(inbound, outbound_request)` 取 **added∪removed∪modified 两侧**文本 → `req_aux`。
- **rewrites-resp（按 transport 拆 round-3 MEDIUM-3）**：流式 diff `sseEvents`↔`inboundResponse.sseEvents` 改动帧 raw；非流式先按 endpoint 归一化 `inboundResponse.content`（unknown、per-endpoint 形）再 diff `outboundResponse.content`；`inboundResponse` 缺失则该源空（文档化）。
- **req/resp-headers**：拼 `key: value` 行、leg/条目间 `\x1e` 隔断 → `req_aux`。
- eager/in-flight **不建**（深搜只覆盖持久；in-flight 由专门页 + 列表均走**内存消息文本扫**，见下）。

## 搜索（专门页 vs 列表快筛，两路分离）

- **专门搜索页（新 REST `GET /history/api/search?source=&q=&limit=&cursor=`，**5 源单选可切换**）**：`source` ∈ 5 facet → LIKE（`ESCAPE '\'` + `escapeLikeNeedle` 转 `\%_`）：
  - `inbound`：`msg_blob.text LIKE X` → 命中 hash → 每 hash 一结果行。**owner 去重即"消除 previous"**（同一消息在 N 请求重复 → 一行）。
  - `rewrites-*/headers`：`req_aux WHERE source=? AND text LIKE ?` → req_id 行。
  - **结果类型（新，reviewer M5 补规格）**：`SearchResultRow = { hash, ownerReqId, snippet, summary: EntrySummary }`。`ownerReqId` = `min(started_at)` 含该 hash 的请求（SQL 取）;`snippet` = JS 对 `msg_blob.text` 做 `indexOf(needle)` 取居中窗口（LIKE 只给存在性、偏移须 JS 算）;**`containingReqIds` 不内联**（可达数百）→ 独立懒端点 `GET /history/api/search/contains?hash=`。**分页 cursor = `(min_started_at, hash)` 复合键**（结果按 owner started_at DESC + hash 稳定排序，抗 reaper 期间漂移）。
  - 结构化过滤（model/status/session/pinned）在解析出的 req_id 集**之后** AND。
  - **build 进度**：完成标志 `search_index_version` 置位前，inbound 搜索结果**部分**（仅已 backfill 的 entry）→ 端点返 `{ partial: true, builtPct }` 提示"索引中"；置位后完整。
  - 限制：跨消息边界 needle 不命中（消息级、罕见）；LIKE ASCII 折叠、CJK 大小写精确。
- **列表内联快筛（轻，as-you-type）**：**只 `preview_text` LIKE** + 结构化过滤、不触 search_index。**v5（reviewer C2 修正）：列表全文体搜是即时、无条件降级为 preview-only**（**无 FTS 兜底**——FTS 在 P2 read 切换后即无人读、P3 删；"FTS 兜底直到标志"只是我 v4 的口误，不存在）。深度全文体搜在专门页（5 源切换）。
- **in-flight（持久未建 search_index）**：专门页 + 列表对活跃 entry **直接内存扫归一化消息文本**（保留一个消息文本提取器、与持久同归一化投影，reviewer M1），merge 持久结果、dedup by id。

## reaping（CASCADE + 门控引用计数 GC，无 splice round-3 HIGH-2/3）

裸 bulk `DELETE entries_v2` → CASCADE 删 `req_msg`/`req_aux`、`prev_req_id` 悬挂无害（无 FK、读时优雅处理）。**孤儿 msg_blob GC 须接全部删除点（reviewer C3，fix-all-comparison-sites 应用到删除点）**：
- **reaper**：仅本 tick 真淘汰了行时（`deleted>0` 门控）、同步单语句 `DELETE FROM msg_blob WHERE NOT EXISTS(SELECT 1 FROM req_msg WHERE req_msg.hash=msg_blob.hash)`（相关子查询走 idx_req_msg_hash、同步无 await→无 finalize 竞态）。
- **`deleteSession`**：同 GC 语句于其删除事务内（删一 session 后部分 msg_blob 成孤儿）。
- **`clearAllEntries`**：直接 `DELETE FROM msg_blob` + `DELETE FROM req_aux`（清全部 entry→全孤儿，无需 NOT EXISTS）。
- `.changes` 被 CASCADE 污染 → `SELECT COUNT`。**round-2 splice 触发器整个不存在。** ⚠ 若只接 reaper（v4 漏 deleteSession/clearAll）→ clearAll 后整个 msg_blob 成永久死空间，重现本 RFC 要消的 bloat。

## prev_req_id（best-effort 血缘，与搜索解耦）

`entries_v2.prev_req_id` = 组内时间最近一条（**finalize 事务外**查、O(1)、无前缀校验、无 FK）。**仅供将来对话线程化/导航、绝不被搜索读**。悬挂引用（前驱被淘汰）线程 UI 优雅处理。**v5（取舍B）：operator 为长远正确现在就建这一列**（成本仅 finalize-外一次索引查 + 一列）；线程化特性本身 deferred、届时再消费。

## 迁移（建索引 + 删 search_text 列 + 弃 FTS，非阻塞后台、**可恢复**）

1. **finalize 双写过渡**（C1，同事务）：旧 search_text（FTS 仍服务）+ 新 msg_blob/req_msg/req_aux/prev_req_id。
2. **后台 backfill（C2，吸收删 preview-backfill）**：重算 preview_text + 建全索引。**净新循环**（非"复用"flat scan）：按 (session,agent)+started_at 序逐条；**多腿解压**（inbound/outbound_request 在 request_group 帧、outbound_response/inbound_response 响应腿〔最大〕、headers，~4-5 腿/条）。**可恢复 + 优雅中途退出**（operator 要求）：
   - **逐 entry 幂等**（`INSERT OR IGNORE`；处理前 `SELECT 1 FROM req_msg WHERE req_id=?` 跳过已建）。
   - **进度游标** `history_meta('search_index_backfill_cursor', <last started_at>)`，每批后更新；重启从游标续、不重头。
   - **响应 shutdown（reviewer C1 修正生命周期）**：`shutdownHistory()` 在 **Phase 1 即 `closeDatabase()`**、远早于 Phase 3 的 `getShutdownSignal()`——故**不能订阅 abort signal**（订了也来不及、DB 已关、下条 prepare 抛在已关句柄）。正解 = **协作式 stop flag**：`shutdownHistory` 在 `closeDatabase` **之前**调 `stopSearchIndexBackfill()`（置 flag + await 当前批落库 + 存游标），再 close；loop 每批查 flag、命中即退。硬关兜底 = 每批已存游标 → 重启续。
   - **完成标志** `history_meta('search_index_version','1')` **只在全部跑完才置位**；置位前 inbound 专门搜索结果**部分**（端点返 partial+builtPct）、**列表已即时走 preview（无 FTS 兜底——v4 的"FTS 兜到 backfill 完"是口误，read 切换后 FTS 即无人读）**。
   - guard：run iff `search_index_version≠'1'`、**绝不读陈旧 `user_version`**（你的库已 =1）。**preview_text 重算**（reviewer H1）：本 backfill 顺带全行重算 preview_text（首跑全量解压、吸收 preview-backfill）；未来 preview 逻辑改用 bump `search_index_version` 重跑（不再有独立 user_version re-arm）。
   - **批量插入/entry-tx + 周期 WAL checkpoint**（防 77k 行插入 fsync 风暴 + -wal 膨胀，round-3 HIGH-4）。预期**数十分钟**（非数分钟），honest。
3. **read 切新索引 + in-flight 内存扫 + 列表 preview LIKE**（C2，gate 在完成标志）。
4. **原子 DROP（C3，实测 DROP COLUMN 抛因 FTS 触发器引用 search_text）**：单 tx 严格序 `DROP TRIGGER ai/ad/au → DROP TABLE entries_fts → ALTER DROP COLUMN search_text`；置 `openDatabase` 内 `reclaimOrphanedActiveRows`(写库触发 au) **之前**；never-throw + `PRAGMA table_info` 验真删（防 BUSY 静默残留）。删 `rebuildSearchIndexIfPresent`。**同 commit 必清写路径列引用**（round-3 CRITICAL，漏一处 finalize 即炸）：
   - `connection.ts:293` `migrateEntriesColumns` `wanted` 删 `{name:"search_text"}`（**否则下次开库 ADD 回、列复活**）。
   - `serialize.ts:{37(EntryRow),230(写)}`、`write.ts` INSERT_ENTRY_SQL 列+ON CONFLICT+bind、`read.ts:144(SELECT)`+`:192(map)`+`:107(LIKE 项)`、`extractSearchText` 删。
5. **VACUUM 回收**（C4）：2.77G FTS + search_text 列 freelist 自动回收。

## 删除/改名 + 全消费者枚举（round-3 CRITICAL-2/3 实测补全）

- 删 FTS 全家 + `preview-backfill.ts`（并入）+ `extractSearchText` + `search_text` 列。`startPreviewBackfill`→`startSearchIndexBackfill`（`state.ts:{25,107}`/`store.ts:27`/`index.ts:36`/`start.ts:{35 import,543 调用}`）。
- **`EntrySummary.searchText` 删字段** → 后端 `read.ts:{144,192}`/`in-flight.ts:{22-31 cache 结构,213}`/`queries.ts:{54-58 in-flight 改内存扫}`/`types.ts`；**前端**：`VActivityPage.vue:137` + 6 测试文件 `ui/tests/store.test.ts:{366,378}`/`activity-helpers.test.ts:24`/`vitest/{activity-row:15,activity-navigation:37/47,detail-page:46-48}`/`e2e-ui/history-mocks.ts:{67,94}`（`satisfies EntrySummary` 字面量含 `searchText` 会 TS2353）。
- 测试改/删：`preview-backfill.it`→改名重写、`search-fts.unit`/`search-backfill.it` 重写、`in-flight-summary-memo.unit`（extractSearchText 删）、`history-ws.unit:51`、`history-summary.it:{5,387,643}`（断言全文体搜——须确认改为走专门页或调整）、`serialize.unit:121`、`history-store.it:570`。

## 测试计划

- **内容寻址/归一化**：同消息跨轮(cache_control 变)归一化后哈希相等→msg_blob 单行（取真实连续两请求实测）；4 格式各自归一化稳定；ide_*/system-reminder 易变子串剥除后稳定;config 切换不改哈希(config-无关)。
- **搜索**：inbound LIKE→每 hash 一行+owner+snippet（owner 去重=消除 previous）；rewrites(含 removed)/headers flat；CJK 2 字子串；跨消息边界 miss 锁定；`%/_` ESCAPE；列表 preview 快筛 vs 专门页全文体搜两路。
- **GC**：删请求→孤儿 msg_blob 被扫除；非孤儿保留;门控(无淘汰不扫);GC 与 finalize 无竞态(同步单语句)。
- **迁移/可恢复**：backfill 建索引+重算 preview(独立 oracle:req_msg join 重建≡原消息)；**中途 abort→游标续跑、不重头、不漏不重**；完成标志只全跑完置位；`user_version=1` 库仍跑；DROP 触发器→表→列原子序+`connection.ts:293` 删防复活+table_info 验删+写路径同 commit；非阻塞;VACUUM 回收。
- golden 预捕获(含 CJK、跨边界已知 miss)。

## 对 v3-storage 的简化

弃 FTS 消除 [[entries-v3-per-leg-storage]] 不变量 #5（rowid 耦合+rebuild）全没、#3（FTS 触发器污染 changes）剩 FK 半。先做本 RFC、再做 v3-storage。

## Open Questions（剩余，实现期定）

- **OQ-A**：req/resp-headers 拆两 facet vs 合一——倾向拆。
- **OQ-B**：在线进程内 backfill vs 离线一次性脚本（`scripts/`）——倾向进程内可恢复后台；超大库可提供离线脚本备选。
- **OQ-C（reviewer H3 加可观测 tripwire）**：易变子串完整清单（cache_control/system-reminder/ide_opened_file/ide_diagnostics/ide_selection/cwd/turn-counter…）须实现期对真实 history 实测枚举全（漏一种→该类消息每轮 re-hash、去重退化、悄悄 bloat）。**安全网**：backfill/运行期把**去重比**（`distinct msg_blob / total req_msg`）作 `history_meta` stat + 启动日志输出；远低于实测 42.7× 即"易变清单不全"的可观测 tripwire（把隐性 landmine 变可检测回归，呼应"通过/空/干净不自证"）。
- **OQ-D（reviewer M3）**：`req_aux`（rewrites/headers flat、**不内容寻址**）实测投影大小未量——响应侧 diff 可能较大且跨请求不去重，恐成新 bloat 头。实现前同 req_msg 的实测严谨度量 req_aux；过大则考虑也内容寻址 aux 文本或截断 diff 长度。
- **OQ-E（reviewer H2）**：`block-diff` 算法核——活的前端树是 `ui/src/utils/block-diff.ts`（非 `ui-v4/`，两副本已分叉）。后端核应从**活树**端口（或先 reconcile 两副本）；"消除前端副本漂移"的 UI re-import 是**独立后续、不进 P0**（避免 P0 "纯新增零行为变更" 被 UI 改动污染）。

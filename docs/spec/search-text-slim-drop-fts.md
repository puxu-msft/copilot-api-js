# RFC: search_text 瘦身 + 弃 trigram FTS（entries_v2，先做）

> Status: **SUPERSEDED** by [search-index-delta-forest.md](search-index-delta-forest.md)。本"瘦字段"方案扔掉全文搜索来回避累积冗余；后继 delta 森林方案**消除冗余本身、保住全文搜索**，operator 经对话定型后取代之。本文保留作设计演进记录（其 drop-FTS 迁移安全发现〔CRITICAL-1/2/3〕已并入后继）。
>
> ~~Status: **DRAFT v2**（设计阶段，未实现）。~~scoped 到**当前 entries_v2**、独立于 [[entries-v3-per-leg-storage]] 且**优先先做**（operator 定）——砍 76% 存储 + 简化 v3。v2 修订：吸收 2 个对抗 subagent review（搜索保真 + 迁移安全）的全部 CRITICAL/HIGH/MEDIUM。流程：设计 → review（已 1 轮）→ 实现（带 implement→audit）。
> 触发：v3 调查期实测 `dbstat` 发现 3.6G 库 **70% 是 trigram FTS 索引（2.5GB）**，非腿数据。

## 实测诊断（裁判依据）

| 占用 | 大小 | 占比 |
|---|---|---|
| trigram FTS 索引（entries_fts_data） | **2536 MB** | **70%** |
| search_text 列 | 247 MB | （占 entries_v2 85%） |
| 腿 blob（entry_stages，真实负载） | 805 MB | 22% |
| preview_text | 0.03 MB | — |
| search_text 平均/条 | **406 KB**（max 954KB） | — |
| **FTS 索引 / 被索引文本** | **2536/247 = 10.3×** | — |

**根因（叠乘）**：① `extractSearchText` 拼**每条消息全文 + 全部 tool_result 内容**，Claude Code 每轮重发整个增长对话 → search_text = 那刻完整对话（~400KB/条）；② trigram 固有 ~10× 放大。**且低质**：session 内累积 → 搜早期文本命中该 session 几乎每条 entry。消息文本**三重存储**（压缩腿 805MB + 明文 search_text 247MB + trigram 索引 2.5GB）。

## 决策（operator 已定）

1. **search_text 瘦身为判别性词条**（删完整累积消息体）。
2. **彻底弃 trigram FTS**（表 + 3 触发器 + rowid 耦合 + VACUUM-后-rebuild + ensureSearchIndex/rebuildSearchIndexIfPresent）；瘦 search_text 小到 `LIKE` 全扫即可、不需任何索引。
3. **在 entries_v2 上做、且先做**（独立于 v3）。

**richest-data-flow 合规**：search_text 是**派生索引字段、非原始数据**——完整消息文本仍在 entry_stages 腿 blob 供展示/导出/详情，裁剪它不丢原始数据（[[feedback-richest-data-flow-store-complete-no-pruning]] 管原始数据腿，搜索范围是合法可调产品决策）。

## 设计

### 瘦 search_text 字段集（`extractSearchText` v2，解 OQ1）

review 校正后的最终集（worst ~12KB/条，~单位数 MB 总量，旧 247MB）：

| 字段 | 来源 | 理由 |
|---|---|---|
| `inboundRequest.model` + `outboundResponse.model` | **head `model` 列**（= `outboundResponse?.model ?? inboundRequest.model`） | 元数据 |
| `endpoint` | **head `endpoint` 列** | 元数据 |
| **`failureReason`**（error 超集） | **head `error_message` 列**（= `outboundResponse?.error ?? failureReason`） | review M1：失败记录是 history 保留的意义（failure_limit 200 > success 50）；aborted/interrupted 的 reason 在 failureReason 非 outboundResponse.error |
| **tool 名**：`tool_use.name` + `tool_calls[].function.name` + 请求 `tools[].name` | inbound blob | 常搜"哪条用了 X 工具" |
| **system：前 8KB** | inbound blob | review H1：2KB 截断砍掉判别部分（CLAUDE.md 前 2KB 是通用前言、跨 session 累积冗余；判别内容〔项目名/模块名〕在更深处）。8KB×数百条仍单位数 MB |
| **首条 user 消息：前 1KB** | inbound blob | session 主题定位 |
| **末条 user 消息：前 2KB** | inbound blob | review H2：当前轮、**entry 级**判别（preview 常是 tool_result marker 非 user 轮，`summarizeMessage` 取末条不论 role；当前用户指令在 preview 与首条都搜不到） |

**删**：assistant 消息体、`tool_result` 内容、中段 user 消息体（累积大头、低质）。

**read-set 契约耦合（review HIGH-2）**：`extractSearchText` v2 加 JSDoc 明列它读的字段集（同 preview-backfill 的 contract-coupling 注释），使 backfill 能精确供给。

### 搜索语义（read.ts + queries.ts）

- **SQL（read.ts）**：删 FTS MATCH 分支 + `FTS_MIN_NEEDLE`/`ftsLiteral`。统一 `WHERE (search_text LIKE ? ESCAPE '\' OR preview_text LIKE ? ESCAPE '\')`。
- **LIKE wildcard 转义（review M2，pin 机制）**：共享 `escapeLikeNeedle(needle)`——转义 `\`、`%`、`_` 三字符，配 `ESCAPE '\'` 子句。**否则**含 `%`/`_` 的 needle 被当通配，且与 in-flight 的 `.includes`（字面）分歧。in-flight 路径（`queries.ts:57` `.includes`）本就字面，转义 SQL 侧使两路一致。
- **in-flight（queries.ts:57）**：已是 `searchText.toLowerCase().includes(...)`，瘦身后同字段一致、**逻辑不改**。
- **语义变化（文档化）**：trigram MATCH 是 Unicode 大小写折叠子串；`LIKE` 只折 ASCII。CJK 子串搜变大小写精确（CJK 无大小写、无影响）；失去对任意中段消息体的子串搜（决策弃之）。`%x%` 前导通配恒全扫——~1MB 列上 <5ms（250-624 条），万条×~12KB=120MB 仍 ~50-100ms（300ms debounce 可接受）。
- **消费者确认（review L1/L2）**：ui-v4 Plan 04 显式把"跨 session 找请求"委托给本全局搜索框（瘦字段集是其 sanctioned 定位器，故 H1/H2 字段质量要紧）；详情内搜索/高亮（`useHighlightHtml`/`detailSearch`）走**详情 blob 全文、独立于 search_text**，瘦身不影响。

### 性能/索引（OQ2 解=否）

search 改 LIKE 后**不**给 search_text 建 B-tree 索引——`LIKE '%x%'` 前导通配用不了前缀索引，全扫；瘦字段全扫已 <5ms，加索引无益反占空间（呼应弃 FTS 初衷）。

## 迁移（drop FTS + 合并 backfill + VACUUM 回收，review 3 CRITICAL 已修）

复用 preview-backfill 的**非阻塞后台**机制（绝不进 `openDatabase` 同步路径，[[methodology-derived-column-backfill-targeted-and-nonblocking]]）。

### 1. 合并 backfill（吸收并删除 preview-backfill）—— **inbound-only（review HIGH-1）**

一个后台 pass 重算 **preview_text + search_text**。**只解压 inbound_request 单腿**（同 preview-backfill 今日）——`model`/`endpoint`/`error_message`/`failureReason` 全在 **head 列**，从行直接读、**零额外解压**；system/首末 user/tool 名从 inbound blob。**不解压 outbound_response 腿**（它是 per-attempt、非 `-1`，且 model/error 已在 head 列——解它是错粒度 + 无谓 I/O）。backfill 构造合成 entry `{ inboundRequest: <blob>, endpoint: row.endpoint, outboundResponse: {model: row.model, error: row.error_message}, failureReason: row.error_message }` 喂 `extractPreviewText`（inbound-only）+ `extractSearchText`v2（按契约 read-set）。
- 按 id 分批、批间 `await sleep(0)`、`SELECT COUNT` 计数（FK 级联仍污染 `.changes`）。
- **双重 never-throw + 版本写置位（review CRITICAL-3）**：镜像 `preview-backfill.ts:204-235` 控制流——整体 try 包全，`history_meta` UPSERT 是循环后**最后**一句；顶层抛**不**写版本（瞬时失败下次重试）；逐 entry 错仍写版本（坏 blob 不每次重扫）。
- **取代并删除 `preview-backfill.ts`**（inbound-only 逻辑并入；改名 `startSummaryBackfill`）。

### 2. 版本 guard —— **全新 history_meta key,独立于陈旧 user_version（review CRITICAL-2）**

建 `CREATE TABLE history_meta(key TEXT PRIMARY KEY, value TEXT)`。gate **逐字**：`SELECT value FROM history_meta WHERE key='summary_version'`；run iff result `!== '2'`；成功 `INSERT OR REPLACE INTO history_meta VALUES('summary_version','2')`。**绝不读 `user_version`**。你的生产库已 preview-backfilled（`user_version=1`）+ search_text 仍肥 → history_meta 无此 key → **跑**（重算 preview+search 为瘦形）。**必测**：`user_version=1` 库上合并 backfill 仍跑并瘦身（否则你开新二进制后 2.5G 永不回收——本 RFC 最关键的一条测试）。`user_version` 单 int 留给将来 v3 schema（呼应 v3 RFC OQ3，避免两轴挤一 int）。

### 3. drop FTS —— **触发器先于表、原子、置于 reclaimOrphanedActiveRows 之前（review CRITICAL-1）**

`entries_v2_fts_ai/ad/au` 是 `AFTER INSERT/DELETE/UPDATE ON entries_v2`、体 `INSERT INTO entries_fts`。若表被 drop 而触发器残存，**下一次 entries_v2 写**（eager upsert / finalize / reaper DELETE / setEntryPinned / 以及 `openDatabase` 内 line 82 的 `reclaimOrphanedActiveRows` 自身的 UPDATE）即 throw `no such table: entries_fts`——**启动崩 + 写库全炸**。故在 `openDatabase` 内、**置于 `reclaimOrphanedActiveRows`(line 82) 之前**，单 `db.transaction()` 内按序：
```sql
DROP TRIGGER IF EXISTS entries_v2_fts_ai;
DROP TRIGGER IF EXISTS entries_v2_fts_ad;
DROP TRIGGER IF EXISTS entries_v2_fts_au;
DROP TABLE IF EXISTS entries_fts;
```
触发器先、表后、无插入写。（`search-backfill.it.test.ts` 的 `stripFtsIndex()` 已是此序，作 canonical 参照。）

### 4. VACUUM 回收（review MEDIUM-1：时序 + page 算术 + 尾部）

- **DROP 置于 `maybeVacuumOnStartup`(line 83) 之前**：首次开库 VACUUM 即把 2.5GB FTS shadow 页回收。
- **page 算术**：迁移开库时 freelist ≈ 2.5GB（FTS drop）/ 3.6GB ≈ 0.69 ≫ 0.25 阈值、≫ 64MB → gate 触发。
- **245MB 旧 search_text 尾部**：合并 backfill 是**后台**（post-listen），DROP 是**同步**（openDatabase）——故首次开库 VACUUM 时 search_text 仍肥（247MB），瘦身后释放的 245MB 在**下次**开库才成 freelist；届时残留 ~1.1GB 中 245MB ≈ 0.22 **可能低于 0.25 gate**→ 由 reaper 的 `incrementalVacuum`（首次全 VACUUM 后 auto_vacuum=INCREMENTAL 模式 2）逐 tick 涓流回收兜底。文档化此两段回收发生在不同开库。
- **FTS 没了 → rowid 耦合没了**：删 `maybeVacuumOnStartup` 内 `rebuildSearchIndexIfPresent` 调用 + 该函数（同 commit）。

### 顺序/commit invariants（每中间态可用，[[methodology-commit-invariants]]）

1. 改 `extractSearchText` 瘦身 + JSDoc 契约（新写即瘦；FTS 仍在、搜索仍 MATCH 旧肥 search_text、能搜）。
2. 建 history_meta + 合并 backfill（重算旧行 preview+search；FTS 仍在）。
3. **同 commit**：drop FTS（触发器先/表后/置 reclaim 前）+ read.ts 切 LIKE+ESCAPE + 删 ensureSearchIndex/rebuild/FTS_SCHEMA_SQL + 删 preview-backfill 模块 + 重命名 startSummaryBackfill 四处 barrel。**drop 与 read.ts 切 LIKE 必须同 commit**（否则 read.ts MATCH 已删表炸 / 或老 read.ts MATCH 已删表炸——单二进制部署，新码同时含新 read.ts + drop，无中间态）。
4. 下次开库自动 VACUUM（+ reaper 涓流尾部）。

## 代码删除/改动集（review HIGH-3/HIGH-4 补全）

- `schema.ts`：删 `FTS_SCHEMA_SQL`。
- `connection.ts`：删 `ensureSearchIndex`(line 88 调用 + 84-87 注释)、`rebuildSearchIndexIfPresent`、`FTS_SCHEMA_SQL` import（保 `SCHEMA_SQL`，编辑双 import 行非删）、`maybeVacuumOnStartup` 内 rebuild 调用、92-96 preview-backfill 接线注释；**加**一次性 DROP-FTS tx（触发器先/表后，置 line 82 前）。
- `read.ts`：删 `FTS_MIN_NEEDLE`/`ftsLiteral`/MATCH 分支 → 统一 LIKE+`escapeLikeNeedle`+`ESCAPE '\'`。
- `preview-backfill.ts`：**整模块删**（并入合并 backfill）。
- `start.ts`/`state.ts`/`store.ts`/`index.ts`：`startPreviewBackfill` → `startSummaryBackfill`（4 site：state.ts:107 定义、store.ts:27 flat re-export 行、index.ts:36 字母序 export 块、start.ts:35+543 import+调用）；post-edit `grep -rn 'startPreviewBackfill' src` === 0。
- `write.ts:145`/`reaper.ts:96`/`connection.ts:254`：`.changes` 注释裁掉 FTS-trigger 那半因由（保 FK-cascade 那半，`SELECT COUNT` 不变）。

## 测试计划（review HIGH-3 补 preview-backfill.it.test.ts）

- **改写/改名**：`preview-backfill.it.test.ts` → `summary-backfill.it.test.ts`（retarget `startSummaryBackfill`、gate 改 history_meta、FTS-JOIN 断言换 `queryEntries({search})` LIKE 断言、加"user_version=1 库上仍跑+瘦身"测）；`search-fts.unit.test.ts`（删 query-plan-uses-FTS + FTS COUNT/'rebuild'/'delete' 断言；MATCH→LIKE 子串搜；加 `%`/`_` ESCAPE 转义断言）；`search-backfill.it.test.ts`（FTS rebuild → 合并 backfill 幂等 + drop FTS 幂等）。
- **新增**：瘦 `extractSearchText` 单测（含/不含哪些字段；system 8KB / 首条 1KB / 末条 2KB 截断边界；`content:null`/空 messages/数组 system 的 null 安全，review L4）；backfilled row 的 search_text === 同 entry live-written（review HIGH-2，镜像 preview-backfill.it.test.ts:142）；needle `"50%"` 在 persisted（SQL ESCAPE）与 in-flight（JS includes）返回**同**行（review M2 一致性）；drop FTS 后 LIKE 全行可命中；DROP-FTS 触发器先/表后不炸后续写（review CRITICAL-1）；非阻塞（异步分批不卡 openDatabase）。
- **golden 预捕获**（瘦身前于旧码捕获，[[methodology-golden-fixture-pre-capture]] + [[feedback-pass-null-clean-not-self-validating]]）：捕获"哪些 needle 当前命中哪些 entry"，含**非 ASCII**（重音拉丁 mid-word，review M3 界定回归）；瘦身后断言高价值 needle（tool/model/failureReason/system 头/首末 user）仍命中、中段 body needle 按设计不再命中、join-boundary needle 行为锁定（review M3）。

## 对 v3 的简化（红利）

弃 FTS 后 [[entries-v3-per-leg-storage]] 的两个紧耦合不变量整个消失：**#5（FTS rowid 耦合 + VACUUM-后-rebuild）** 全没；**#3（FTS 触发器污染 `.changes`）** 只剩 FK 级联半。v3 迁移里"两表 FTS 搜索窗口"（v3 OQ-A）、"FTS content 表重指 + rebuild"全消失。**先做本 RFC、再做 v3**，v3 显著变简单。

## 剩余 Open Questions

- **OQ-tail（独立后续，非本 RFC）**：真需消息体全文搜时的"专门索引"——独立 DB 文件 / 按每轮增量判别内容（非累积）/ 词 tokenizer / config flag 懒填充。留待真实需求，不投机预建。
- **OQ-system-tail**：system 8KB **头** vs `4KB 头 + 2KB 尾`（CLAUDE.md 作者常把项目特定规则放末尾）——实现期可二选，8KB 头为默认。

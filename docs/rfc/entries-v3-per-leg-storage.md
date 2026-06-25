# RFC: entries_v3 —— 每生命周期腿一等列存储

> Status: **DRAFT v2**（设计阶段，未实现）。本 RFC 走 [[big-feature-pipeline]]：设计稿 → 3+ 轮对抗 subagent review → companion plan + per-phase prompts → 按 phase 实现。
> v2 修订：吸收第 1 轮 3 个对抗 subagent review 的发现 + 实测校正存储画像。触发：preview backfill 事故暴露 `request_group` 合并帧"为读一腿要解压三腿"的劣势（见 [[methodology-derived-column-backfill-targeted-and-nonblocking]]）。

## 决策记录（operator 已定 + review 后定的硬约束）

1. **形状 = 每腿一等列、弃 dedup**：每个生命周期腿成专属 BLOB 列，去掉 generic `(stage, attempt_index)` 行模型 + `request_group` 合并帧容器。各腿独立压缩，放弃合并帧省的 ~3×——换代码直白 + 定向读无容器解码。
2. **迁移 = 全量迁移后弃 v2**：读每条旧 entry → 重写 v3 → DROP 旧结构（沿用 v1→v2 `scripts/migrate-legacy-entries.ts` 模式：幂等、全成功才 drop）。**非阻塞后台**（绝不进 `openDatabase` 同步路径）。
3. **取消 identity-dedup**（review 定）：effective 与 inbound 是不同形状（`RequestLegData` vs inline inbound 类型，`types.ts`），永不深等，dedup 分支永不触发或产错形数据；且重新引入条件读违背"代码直白"。NULL 腿列**单一含义=该腿缺席**，不overload。
4. **采用变体 B（新表）非 A（in-place ALTER）**（review 定）：B 给**无歧义的表成员消歧**（行 ∈ entries_v3 = 已迁、NULL 腿=真缺席）+ 干净 FTS 重建 + 不撒"v2 表装 v3"的命名谎。A 的 in-place 省拷优势在实测下不成立（见下）。

## 实测校正的存储画像（裁判依据，非推断）

`sqlite3 dbstat` 实测当前 3.6G 库（624 entries / 2268 stage 行）逐表字节：

| 占用 | 大小 | 占比 | 说明 |
|---|---|---|---|
| **entries_fts_data** | **2529 MB** | **70%** | trigram FTS 索引——真正的存储大头 |
| entry_stages | 805 MB | 22% | 腿 blob（真实负载，含 request_group dedup 后） |
| entries_v2 | 290 MB | 8% | head 行 |
| freelist | 5 MB | ~0 | 几乎无死空间 |

**校正三方误判**：① reviewer 的"4.2G 是 freelist mirage、活数据 ~29MB" 错（freelist 仅 5MB）；② 初稿假设"全是活腿数据" 错（腿仅 805MB）；③ 真相是 **trigram FTS 索引 2.5GB 占 70%**（对 290MB 文本建 2.5G 索引——trigram 覆盖超大 message 文本的固有代价）。

**对 v3 的三点影响**：
- **迁移只重写 ~1.1GB**（stages 805MB + heads 290MB），远小于各方估计；后台分块可行。
- **"弃 dedup"的存储增长次要**：腿 805MB→约 1.5GB（请求体 ~3×），相对 2.5GB FTS 是噪声。
- **A/B 取舍中"峰值磁盘"论据弱化**：B 多拷 ~1.1GB 临时占用可接受；FTS 两方案都要重建。故选 B（理由是腿数据本就不大 + B 的消歧/FTS/命名干净，**非** freelist mirage）。
- **独立发现（出 v3 范围）**：2.5GB FTS 索引严重失衡（索引 ≫ 被索引文本），是独立可行动项（trigram 粒度/search_text 体量/是否值得这么大索引），**单列后续，不并入 v3**。

## 动机

`entries_v2` **已经**是 head 行 + `entry_stages` 表（每腿一行）。preview-backfill 事故照出两处复杂度债：

- **`request_group` 合并帧**（B3）把 inbound+effective+outbound 三个 >90% 冗余请求体压进一个 zstd 帧——任何只读一腿的消费者都得解压整帧（`extractInboundRequestFromStageBlob` 这个 helper 的存在本身即症状）。
- **generic `(stage, attempt_index)` 行模型 + 容器**：没有哪个腿是一等可寻址字段；每个定向读都要 stage 字符串匹配 + 容器感知解码（`decodeStageRows`）。

v3 把每腿提升为一等列、去掉容器与 generic 模型。**真实收益是架构整洁 + 未来定向读平凡化**，非当前热路径性能（定向读收益现已边际：backfill 已根治、列表 column-only、详情读全腿）。

## 目标 / 非目标

**目标**：6 腿（inbound_request / effective_request / outbound_request / outbound_response / inbound_response / sse_events）各成 entries_v3 专属 BLOB 列、可独立 SELECT；删 `entry_stages` 表 + `request_group` 容器 + 一系列容器逻辑；多 attempt 重试体下沉 side 表 `entry_attempt_legs`；全量后台迁移→drop 旧结构→**终态单一读路径**；preview-backfill 被 v3 迁移**吸收并删除**（迁移即用当前逻辑重算 preview_text/search_text）。

**非目标（守住）**：不改 `HistoryEntry` 7 腿 + 5-腿 httpHeaders 数据模型（前端经 `~backend/*` 消费全部腿，richest-data-flow——存全、选展、绝不裁字段，[[feedback-richest-data-flow-store-complete-no-pruning]]）；不改 FTS 子串搜索语义；不改 reaper/sessions-agg/stats/列表投影对外行为；不改 in-flight + WS 事件流；**不借机动 2.5GB FTS 失衡**（独立项）。

## 必须保留的紧耦合不变量（12，review 校验后）

1. **`pinned` 列只由 `setEntryPinned` 写**——head INSERT/UPSERT 故意省略（DEFAULT 0、eager 重 upsert 不重置）。
2. **head upsert 必须 `ON CONFLICT DO UPDATE`、绝不 `INSERT OR REPLACE`**（REPLACE 的 DELETE+INSERT 触发子表 CASCADE 清腿）。
3. **`.run().changes` 被 FTS 触发器+级联污染**——所有计数用 `SELECT COUNT`（含迁移器逐行计数），[[reference-bun-sqlite-get-null-and-trigger-changes]]。
4. **bun:sqlite `.get()` 返 `null`、node:sqlite 返 `undefined`**——存在性用 `Boolean(row)`。
5. **FTS external-content 的 `content='...'` 在 vtable 创建时冻结**——改表名/换内容表必须 DROP+重建 FTS vtable + 3 触发器 + `'rebuild'`；rowid 经全量 VACUUM renumber 后亦须 rebuild。
6. **`status` 列（非字段存在性）是 partial/terminal 权威**；assemble 对缺腿优雅降级（NULL 腿 → `undefined`）。
7. **`inboundRequest` 在读时被 floor**（缺 inbound 腿时给 `{model: row.model}`，详情消费者不崩）——v3 此 floor 归 `assembleEntryV3`。
8. **tombstone 路径**：finalize 永久失败只写 head + inbound_request + outbound_response 两腿（head-only fallback 则零腿）——这两列须可独立写。
9. **final-attempt mirror 优先**：final attempt 槽用顶层 `entry.outboundResponse`（fail() 设了它但 finalAttempt.response 为 null）。
10. **加腿/字段须同步 history sink 显式投影**（`onTerminal`）——round-trip 丢未投影字段。
11. **legacy 兼容兜底**：迁移期未迁旧行仍可读（按表成员消歧 → 走 v2 `assembleFullEntry`）。
12. **derived 列写时算（derive-then-split）**：request_bytes/response_bytes（多腿派生）、preview_text、search_text（**多腿**：inbound + outbound_response）、message_count、multiplier、pid/boot_time/git_sha——在整 entry 上算完**再**拆列。

## v3 schema 设计

### entries_v3 head 行（保留全部 v2 索引列 + head_meta + 6 腿列）

```sql
CREATE TABLE entries_v3 (
  id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER,
  model TEXT, endpoint TEXT, transport TEXT, status TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER,
  cache_creation INTEGER, reasoning_tokens INTEGER, stop_reason TEXT,
  error_message TEXT, message_count INTEGER,
  preview_text TEXT, search_text TEXT,
  pid INTEGER, boot_time INTEGER, git_sha TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  request_bytes INTEGER, response_bytes INTEGER, multiplier REAL,
  head_meta_gz BLOB NOT NULL,           -- 轻量剩余（denylist，见下）
  inbound_request_gz  BLOB,             -- 6 腿列，各独立 zstd，nullable=该腿缺席
  effective_request_gz BLOB,
  outbound_request_gz BLOB,
  outbound_response_gz BLOB,
  inbound_response_gz BLOB,
  sse_events_gz       BLOB              -- final/成功 attempt 的帧（attempt_index -1 语义）
);
-- 索引与 v2 逐一对应（started_at / session / model / status / endpoint / pid /
-- session_agent / 部分 active）。
```

### entry_attempt_legs（仅非-final attempt 重试体，封闭 4-腿集）

```sql
CREATE TABLE entry_attempt_legs (
  entry_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL,       -- ∈ [0, finalIdx) —— final attempt 不在此，在 head 列
  leg TEXT NOT NULL,                    -- 封闭集：effective_request|outbound_request|outbound_response|sse_events
  blob_gz BLOB NOT NULL,
  PRIMARY KEY (entry_id, attempt_index, leg),
  FOREIGN KEY (entry_id) REFERENCES entries_v3(id) ON DELETE CASCADE
);
CREATE INDEX idx_attempt_legs_entry ON entry_attempt_legs(entry_id);
```

**side 表的正确理由（review 校正）**：非-final attempt 体是**无界 1-对-多的重 blob**（L2 RST 重试至 `protect_streaming_max_retries`、auto-truncate 至 5、strategy 重试），每个携完整 effective/wire/response/sse（可达数 MB）。塞进 `head_meta_gz`（每次 list/preview/detail 读都解压、且 derived 列从它派生的那唯一 blob）会摧毁"head 是轻量剩余"前提。side 表是这个 1-对-多的自然规范化，继承 `entry_stages` 既有的 CASCADE + reaper 解耦——**不是为罕见场景的投机 surface**（"单 attempt 零行"是好性质、非理由）。**封闭集排除 inbound_response**（它是 leg-independent 顶层、永不 per-attempt）。

### history_meta（迁移完成 guard，解 OQ3）

```sql
CREATE TABLE history_meta (key TEXT PRIMARY KEY, value TEXT);
-- v3 迁移完成置 ('schema_version','3')；C4 的 drop 仅在此 == '3' 后。
```

**为何不复用 `user_version`**（review 定）：单 int 无法编码两正交轴（preview 逻辑代 ⊥ schema 版本），且 preview-backfill 正被删除——overload 其 int 是对一个将消失模块的无谓耦合。KV 表清晰、可扩展、给 C4 一等布尔。

### 字段归属全分类（richest-data-flow gate，review 补的穷尽表）

**`extractHeadMetaV3` 必须是 denylist 非 allowlist**（review CRITICAL）：拷 entry 全部键，**排除** `META_KEYS ∪ {6 腿键}`、并 strip attempts[] 的 per-attempt 重体——**绝不**用正向 allowlist（否则 `rawPath`/`failureReason`/`warningMessages`/`lastUpdatedAt`/`queueWaitMs`/`currentStrategy` 等顶层字段静默丢失）。三个命名 key-set 作常量（镜像今日 `META_KEYS`/`STAGE_TOP_KEYS`/`ATTEMPT_BODY_KEYS`）：

| HistoryEntry 字段 | v3 归属 |
|---|---|
| id/sessionId/agentId/startedAt/endedAt/durationMs/endpoint/transport/state/pinned/requestBytes/responseBytes/multiplier | head 列（META_KEYS） |
| pid/boot_time/git_sha（process 镜像）+ model/tokens/stop_reason/error_message/message_count/preview_text/search_text | head 列（派生/镜像） |
| **rawPath / failureReason / warningMessages / lastUpdatedAt / queueWaitMs / attemptCount / currentStrategy / pipelineInfo / process / httpHeaders（顶层聚合，解 OQ1）/ attempts[] 摘要** | **head_meta_gz**（denylist 剩余） |
| inbound/effective/outbound_request · outbound/inbound_response · sseEvents（顶层 final） | **6 腿列** |
| attempts[].{effectiveRequest,wireRequest,response,sseEvents}（非-final） | **side 表** |
| **attempts[].responseHeaders** | **head_meta attempts 摘要**（逐字同 v2——`ATTEMPT_BODY_KEYS` 不含它；side 表 4-腿集无它的家，review CRITICAL） |
| `RequestLegData.headers`（per-腿，如 outboundRequest.headers） | 随该腿列 payload（已是腿字段）；与顶层 `httpHeaders.outboundRequest` 聚合**双存**，richest-data-flow 故意，**勿 dedup** |

**OQ1 解（httpHeaders）**：`types.ts` 实证 `httpHeaders` 是顶层 5-腿聚合对象（前端 `HeadersSegment.tsx` 读 `entry.httpHeaders.outboundResponse`，非 `entry.outboundResponse.headers`）→ 进 `head_meta_gz`，**不**拆腿列（拆会改模型）。

## 读 / 写路径 redesign

### 写（两条 upsert 语句，review CRITICAL F3）

**绝不**把腿列放进状态/eager upsert 的 `DO UPDATE SET`（否则 eager 重 upsert 用 NULL 覆盖已写腿，正是 v2 拆表要避免的）。两条独立语句：
- **head-only upsert**（eager pending / 状态转换）：只写 head 列 + head_meta_gz，`DO UPDATE SET` **排除 6 腿列 + pinned**（镜像 pinned 排除）。腿列保持已有值。
- **finalize upsert**：写 head + head_meta + 6 腿列 + 删旧 attempt_legs 重写。腿列 = final/顶层 mirror 体（缺则 NULL；不变量 #9 mirror 优先）。tombstone 只 SET inbound_request_gz + outbound_response_gz（其余腿列保持/NULL）。
- **derive-then-split**（不变量 #12）：`deriveRequestBytes`/`deriveResponseBytes`/`extractSearchText`（多腿）在整 entry 上算完**再**拆列——绝不 per-column 算（否则 sse-vs-response 优先级、三腿 fallback 失序）。

### 读（按表成员消歧，review HIGH F2/H2）

- **消歧规则（钉死）**：id ∈ entries_v3 → 权威 v3 行，NULL 腿 = **真缺席**（不变量 #6 优雅降级、inbound floor #7）；id ∉ entries_v3 → 回退 v2 `assembleFullEntry`。**绝不**用"腿全 NULL → 回退 v2"（tombstone/eager-pending 行天然腿全 NULL，会被误判未迁）。
- `assembleEntryV3(row, attemptLegRows)`：head_meta 解压 + 列镜像覆盖；6 腿列非 NULL 则 decompress 填顶层字段、NULL → undefined；attempts[] = head_meta 摘要 + side 表回填非-final 体 + final 槽从顶层腿列 mirror（不变量 #9）。
- **定向读平凡化**：preview 重算只 `SELECT inbound_request_gz`、decompress、`extractPreviewText`——无容器、无 `extractInboundRequestFromStageBlob`。
- **`queryEntries` 禁 `SELECT *`**（review F14）：v3 下 `SELECT *` 会拖 6 个 BLOB 列；改 `SELECT <head 列 + head_meta_gz>`，腿列仅在真要组装全 entry 时按需 load。`querySummaries` 仍 column-only（不碰任何 blob）。

### final-attempt 边界（review F5/F6）

side 表持 `attempt_index ∈ [0, finalIdx)` **only**；final 槽**独占** head 列，由顶层-mirror-优先填。column-vs-side 判据对**全 4 个 per-attempt 腿（含 sse）**统一 = `index === finalIdx`（单 attempt finalIdx=0 → 帧进 sse_events_gz 列，即使是 RST-截断的成功末态）。

### 死代码集（C4 删除，review L1，防死代码残留）

`decodeStageRows`、`extractInboundRequestFromStageBlob`、`partitionStagesForWrite`、`isRequestGroupStage`、`REQUEST_GROUP_STAGES`、`STAGE.requestGroup` 成员、`loadStagesFor`、`RequestGroupMember`、`StagePayload`/`StageRow` 中 stage 相关、`extractStagePayloads`、`preview-backfill.ts` 整模块 + `start.ts`/`state.ts`/`store.ts`/`index.ts` 的 `startPreviewBackfill` 接线。

## 迁移策略（变体 B，非阻塞后台，数据安全 review CRITICAL F1/F8）

机制：建 entries_v3 + entry_attempt_legs + history_meta；后台分块逐条 v2→v3；全成功才 drop。**绝不进 `openDatabase` 同步路径**（吸取 preview-backfill 3m53s 卡启动教训）。**绝不对运行中服务器内联 auto-DROP 旧结构**——drop 是独立的、quiescent-gated 步骤。

**安全序（review F8：切写在迁移之前）**：
1. **C1**：v3 schema + serializeEntryV3/assembleEntryV3/extractHeadMetaV3 + 按表成员 dual-read（id∈v3 走 v3，否则 v2）。**写仍 v2**。v3 读路径用合成 fixture 覆盖（此时无 v3 数据，invariant 明说 schema-plumbing-only）。invariant：新增读能力、旧写旧读全绿、零行为变化。
2. **C2**：写路径切 v3（含 tombstone/eager 也写 entries_v3）。**此后无新 entry_stages 行产生**——消除"迁移器与并发 finalize 竞争新 stage 行"的丢数据竞态（F1 核心）。旧行仍 v2、dual-read 按成员兜。invariant：新写 v3、旧读 v2，round-trip 等价 golden 锁。
3. **C3**：后台迁移器（逐条读 v2 `assembleFullEntry` → `serializeEntryV3` 经**canonical 写路径**重派生全 derived 列 → upsert entries_v3 + attempt_legs → 同一 tx 内 DELETE 该 v2 行，避免双存）。幂等（崩溃后重跑安全）。计数用 `SELECT COUNT` 非 `.changes`（不变量 #3）。FTS：迁移期 entries_v2 的 FTS 仍服务未迁行的搜索；entries_v3 FTS 经触发器同步已迁行——**两表搜索窗口**，UI 搜索在迁移期可能短暂不全（一次性、可接受、文档化）。
4. **C4**：完成检测（`SELECT COUNT(*) FROM entries_v2` == 0，因 C3 迁完即删行）→ 置 `history_meta.schema_version=3` → `DROP TABLE entries_v2`（CASCADE 清其 entry_stages）→ `DROP TABLE entry_stages` → 重建 FTS vtable `content='entries_v3'` + 触发器 + `'rebuild'` → VACUUM 回收（renumber rowid）→ **VACUUM 后再 `'rebuild'` FTS**（不变量 #5，review L3：迁移器 VACUUM 不在 openDatabase 序列里，须自己接 rebuild）→ 删 preview-backfill 死代码集 + 移除 dual-read 回退。invariant：drop 仅 100% 迁完后；终态单一路径单一 FTS。

**完成检测原子性（review F1）**：因 C2 后无新 stage 行、C3 迁完即删 v2 行，C4 的 `COUNT==0` 检测与 drop 在同一逻辑步内、无并发 writer 能再造 v2 行（写已全 v3）。仍保守：drop 前于同一 tx 内 re-count。

**literal `entry_stages` 引用须全改/删**（review F12）：`write.ts:179` `clearAllEntries` 的显式 `DELETE FROM entry_stages`（drop 后会 throw "no such table"）、`read.ts:25` stage-load、`preview-backfill.ts`（整删）——C4 枚举全部 literal 引用逐个处理；CASCADE 改靠 `entry_attempt_legs`（依赖 `PRAGMA foreign_keys=ON`，开库已设）。

## commit invariants（每个中间 commit 不半坏，[[methodology-commit-invariants]]）

见上 C1–C4，每个终态系统可用。每 commit 跑全 `tests/history/**` 绿 + 等价性 golden。**golden 预捕获**（review F17 + [[methodology-golden-fixture-pre-capture]]）：在 C1 之前、于**旧代码路径**上捕获每种 entry 形态经 `assembleFullEntry` 的逐字段期望对象、持久化到磁盘，使等价 oracle 独立于 v3 新码（自洽不算数，[[feedback-self-consistent-needs-independent-oracle]]）。

## 测试计划

- **保留全绿**：消费者地图列的全部 `tests/history/sqlite/**` + `tests/history/**`（多数断言对外行为不变→应原样绿；表名/内部结构断言随改）。
- **新增 golden（独立 oracle，逐字段 deepEqual `assembleFullEntry`(迁移前) ≡ `assembleEntryV3`(迁移后)）**，覆盖：单/多 attempt、**fail()-带前序 attempt**（顶层 outboundResponse 设、finalAttempt.response null、≥1 非-final）、**L2 多 attempt sse**（N 失败 attempt 各带全帧 + final 成功）、tombstone（2 腿 + 余 NULL + inbound floor）、缺腿、legacy 单 blob、request_group 帧、**`rawPath`/`failureReason`/`warningMessages`/`queueWaitMs`/`currentStrategy`/per-attempt `responseHeaders` 逐字段 round-trip**（denylist gate）、derived 列与全新写同形态逐字节相同。
- **新增机制测**：腿列定向读（只 SELECT 一列不解压它列）；按表成员消歧（tombstone/eager-pending 全-NULL-腿 v3 行**不**回退 v2）；迁移幂等（反复跑稳定）；drop 仅 100% 迁完触发；迁移非阻塞（异步分块、不卡 openDatabase）；C4 后 FTS（VACUUM 后 rebuild）对全行可搜。

## 实现前还需（review M5）

本 RFC 是 **design**（WHY + 契约）。多 implementer 并行执行前需 companion **plan**（HOW + factory-anchor 表：`serializeEntryV3`/`assembleEntryV3`/`extractHeadMetaV3`/`migrateV2ToV3Row`/`loadAttemptLegsFor`/三个 key-set 常量/两条 upsert SQL/消歧规则/完成谓词 SQL/死代码集）+ per-phase **prompts**（自包含编码 C1–C4 commit invariants），见 [[methodology-rfc-multi-phase-doc-structure]]。

## 剩余 Open Questions

- **OQ-A（迁移期两表 FTS 搜索窗口）**：C3 期间 entries_v2 与 entries_v3 各持 FTS，UI 搜索短暂不全。可接受（一次性后台迁移、分钟级）并文档化，还是迁移期 UI 搜索 union 两表 / 暂禁？建议接受 + 文档化（搜索是便利、非正确性）。
- **OQ-B（独立于 v3）**：2.5GB FTS 索引失衡（索引 ≫ 文本 8.7×）是否单开 RFC 治理（trigram 粒度、search_text 体量上限、或 FTS 是否值得这么大）？**不并入 v3**，但 v3 的 FTS rebuild 会重生此索引，故值得并行评估。

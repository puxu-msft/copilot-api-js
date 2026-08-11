# History V3 SQLite schema

> **状态：活文档。** 本文描述当前生产代码实际创建和读取的 History V3 SQLite schema。Canonical floor 的 DDL 单一事实源是 [`src/lib/history/v3/store.ts`](../src/lib/history/v3/store.ts) 的 `V3_SCHEMA_SQL`；forward migrations 在 [`src/lib/history/sqlite/migrations/index.ts`](../src/lib/history/sqlite/migrations/index.ts) 注册。Summary projection 的字段与 invalidation trigger 由无运行时依赖的 schema 叶子 [`src/lib/history/v3/summary-schema.ts`](../src/lib/history/v3/summary-schema.ts) 定义，运行时查询／backfill 在 `summary-store.ts` 消费同一字段映射，canonical strict repair 在 `store.ts` 发布 readiness；raw sidecar 的 DDL 单一事实源是 [`src/lib/history/raw/manager.ts`](../src/lib/history/raw/manager.ts) 的 `RAW_SCHEMA`。

## 1．数据库命名与职责

当前 History V3 **没有活跃的 `history.db + archive.db` 双库**。这两个文件名属于已退役的 V2／tiered-archive 设计，生产服务不会打开、迁移、回填或删除它们。V3 与派生 sidecar 如下。

| 逻辑角色 | 当前文件 | 默认路径 | 是否默认启用 | 说明 |
|---|---|---|---|---|
| Semantic History DB | `history-v3.db` | `$XDG_DATA_HOME/copilot-api/history-v3.db`，未设置 XDG 时为 `~/.local/share/copilot-api/history-v3.db` | 是 | `ModelOperationRecord` 的权威 semantic CAS、manifest、ordered tracks、timeline、journal；**不含全文索引** |
| Raw capture sidecar | `raw.db` | 与 `history-v3.db` 同目录 | 否 | 可选 exact-byte CAS 与 operation/sequence/track 引用；配置热重载按 store generation 切换 |
| Search sidecar | `history-search/` | 与 `history-v3.db` 同目录 | 是（磁盘 History） | 独立常驻服务持有的 Tantivy v1 倒排索引；可删除、可重建、非权威。`GET /history/api/search?source=inbound` 经 UDS 查询；不可达时返回 `partial:true` 空结果 |
| Legacy V2 | `history.db` | 同 `$XDG_DATA_HOME/copilot-api/` 目录 | 否 | 保留原样；不是 V3 schema，不被在线服务触碰 |
| Legacy tiered archive | `archive.db`、seal files | 原归档目录 | 否 | 内置 archiver 已退役；不是 V3 schema，不被在线服务触碰 |

因此，如果运维语境仍把两个 V3 库简称为“history DB + archive DB”，对应关系应理解为：**semantic `history-v3.db` + optional raw `raw.db`**，而不是字面文件 `history.db + archive.db`。

路径常量在 [`src/lib/config/paths.ts`](../src/lib/config/paths.ts)：`PATHS.HISTORY_V3_DB`、`PATHS.HISTORY_RAW_DB` 与 `PATHS.HISTORY_SEARCH_DIR`。`history.enabled=false` 或 CLI `--no-history` 会在开库前关闭整个 History 子系统；`history.raw_capture.enabled=false` 只关闭 raw sidecar，不影响 semantic V3。

## 2．总关系图

```mermaid
erDiagram
    HISTORY_STORE_IDENTITY ||--|| V3_META : owns
    V3_OPERATIONS ||--o| V3_OPERATION_SUMMARIES : projects
    V3_OPERATIONS ||--o{ V3_TRACKS : has
    V3_OPERATIONS ||--o{ V3_TIMELINE_CHUNKS : has
    V3_OBJECTS ||--o{ V3_OPERATIONS : resolved_through_manifest
    V3_SEQUENCE_NODES }o--|| V3_OBJECTS : points_to_item
    V3_SEQUENCE_NODES }o--o| V3_SEQUENCE_NODES : extends_prefix
    V3_OPERATIONS ||--o{ V3_OPERATION_EVIDENCE_REFS : owns
    V3_JOURNAL ||--o{ V3_JOURNAL_EVIDENCE_REFS : owns
    V3_TRANSPORT_EVIDENCE ||--o{ V3_OPERATION_EVIDENCE_REFS : referenced_by
    V3_TRANSPORT_EVIDENCE ||--o{ V3_JOURNAL_EVIDENCE_REFS : referenced_by
    V3_JOURNAL ||--o| V3_OPERATIONS : recovers_into
    V3_OPERATIONS ||--o| V3_SUMMARY_BACKLOG : records_summary_failure
    RAW_STORE_IDENTITY ||--o{ RAW_OBJECTS : owns
    RAW_OBJECTS ||--o{ RAW_REFS : referenced_by
```

`v3_operations.manifest_gz` 内有 operation-local handle → `v3_objects.hash` 的映射，所以 `v3_objects` 与 `v3_operations` 没有 SQL FK。这个边由 manifest 保持，读取时批量解析并校验；每个按row读取的入口还必须把SQL选中的 `operation_id` 作为expected identity传入hydrate，manifest内嵌 `record.identity.operationId` 不一致即fail loud，不能借另一row的合法manifest／digest通过。SQL层只为operation-owned子表建立FK。journal与operation也没有FK，且正常情况下不共存：journal先于operation行出现，成功提交后即删除。raw侧同样没有SQL FK：`raw_store_identity` 是artifact身份标记，`raw_refs.object_hash` 是到 `raw_objects` 的逻辑引用。

## 3．`history-v3.db` schema

### 3.1 `history_store_identity`

由 [`src/lib/history/sqlite/connection.ts`](../src/lib/history/sqlite/connection.ts) 的 `assertV3Owner()` 创建，不在 `V3_SCHEMA_SQL` 字符串内。

| 列 | 类型 | 约束 | 语义 |
|---|---|---|---|
| `owner` | `TEXT` | `PRIMARY KEY` | 固定为 `copilot-api-history-v3` |

已有文件若没有该表，或 owner 不匹配，V3 会在执行 schema reconcile 前拒绝打开，防止把旧 `history.db` 误当 V3 改写。

### 3.2 `v3_meta`

| 列 | 类型 | 约束 | 语义 |
|---|---|---|---|
| `key` | `TEXT` | `PRIMARY KEY` | V3 schema／store 元数据键 |
| `value` | `TEXT` | `NOT NULL` | 元数据值 |

当前生产代码写入并读取 `schema_version`。当前 schema version 为 `6`：新库由 `V3_SCHEMA_SQL` 直接建立 schema 6；既有 schema 5 由 forward migration `001-transport-evidence-schema` 原子增加 transport evidence entity、两类 normalized refs 与 `v3_journal.format_version` 后升级。`ensureV3Schema()` 不抢 migration 的版本迁移职责：遇到旧版本保持原状，migrations完成后才执行当前 floor 的幂等 reconcile。更早的 v4→v5 仍在同一事务中移除内置 search tables；旧 `history.db` 不会被打开。

### 3.3 `v3_objects`

Semantic payload/frame 内容寻址对象库。

| 列 | 类型 | 约束 | 语义 |
|---|---|---|---|
| `hash` | `TEXT` | `PRIMARY KEY` | SHA-256 十六进制内容键 |
| `kind` | `TEXT` | `NOT NULL` | `payload`、`payload-skeleton`、`sequence-item` 或 `frame` |
| `canonical_gz` | `BLOB` | `NOT NULL` | canonical JSON bytes 的 zstd 压缩结果 |
| `canonical_bytes` | `INTEGER` | `NOT NULL` | 压缩前字节数 |

Canonical JSON 递归排序 object key，保持 array 顺序；typed-array 转为 `{ "$bytes": "<base64>" }`。当前新写入 `FORMAT_VERSION=3`，hash 域为 `history-v3:3:object:${kind}\0` 加 canonical bytes。hash 命中时仍解压并做完整字节比较；不把哈希相等直接当成内容相等。format-v1／v2 对象留在各自 hash domain，不在线重写。

### 3.4 `v3_sequence_nodes`

可提取对象数组的持久前缀 DAG。每个 node 表示“parent prefix + 当前 clean item”，不同 operation/分支共享相同前缀。

| 列 | 类型 | 约束 | 语义 |
|---|---|---|---|
| `hash` | `TEXT` | `PRIMARY KEY` | sequence node 的 format-v2 内容键 |
| `parent_hash` | `TEXT` | nullable | 前一 prefix node；首项为 `NULL` |
| `item_hash` | `TEXT` | `NOT NULL` | `v3_objects` 中 `sequence-item` 的逻辑引用 |
| `depth` | `INTEGER` | `NOT NULL` | 1-based prefix 长度 |

`cache_control`／`ephemeral` 不参与 clean item identity；每次出现的值作为 manifest overlay（item index + nested path + value）保存，hydrate 时恢复。因此 volatile hint 不会破坏稳定对话前缀共享，也不会丢失原始 JSON 语义。当前没有 SQL FK：node/object 完整性由写入时 collision check 与读取时长度／对象存在校验保证。

### 3.5 `v3_operations`

一条 terminal model operation 一行，是 list/detail 的根表。

| 列 | 类型 | 约束 | 语义 |
|---|---|---|---|
| `operation_id` | `TEXT` | `PRIMARY KEY` | canonical operation ID |
| `revision` | `INTEGER` | `NOT NULL` | terminal record 的 `lastSequence` |
| `digest` | `TEXT` | `NOT NULL` | `SHA-256("history-v3:${FORMAT_VERSION}:operation\0" || manifest_bytes)` |
| `kind` | `TEXT` | `NOT NULL` | `generation`、`responses_ws`、`count_tokens`、`embeddings` |
| `created_at` | `INTEGER` | `NOT NULL` | operation 创建 epoch ms |
| `terminal_sequence` | `INTEGER` | `NOT NULL` | terminal event sequence |
| `ended_at` | `INTEGER` | nullable | terminal epoch ms；旧数据可为空 |
| `timing_source` | `TEXT` | `NOT NULL` | `canonical`、`storage-commit-upper-bound`、`terminal-log-rounded` 或 `unavailable` |
| `manifest_gz` | `BLOB` | `NOT NULL` | format-v3 value-free record、handle→hash、payload sequence roots/overlays、`tracksExternal` 与 ordered transport evidence refs，zstd 压缩 |
| `summary_json` | `TEXT` | nullable | canonical-owner strict repair 从当前 manifest／CAS／timing overlay重算的 summary 载体；marker缺席时作为 canonical fallback 的兼容输入，并同源投影到 `v3_operation_summaries` |
| `pinned` | `INTEGER` | `NOT NULL DEFAULT 0` | debug pin 单写入口；UPDATE trigger 同事务投影到窄表，不写回 manifest |
| `committed_at` | `INTEGER` | `NOT NULL` | authoritative commit epoch ms |

索引：

- `idx_v3_operations_created(created_at DESC, operation_id DESC)`：稳定时间排序与分页。
- `idx_v3_operations_kind(kind, created_at DESC)`：按 operation kind 过滤。

同一 `operation_id + revision + digest` 重放是幂等 no-op；同 operation ID 出现不同 revision／digest 是冲突，写入失败并增加 `conflicts` 状态计数。

### 3.6 Transport evidence 与 normalized refs

`v3_transport_evidence` 以 SHA-256 digest 为主键保存捕获的 transport bytes：`encoding` 当前只接受 `binary`，`evidence_gz` 保存压缩 bytes，`byte_length` 保存解压后长度。写入采用内容寻址 CAS：既有 digest 必须逐项通过 encoding／length／bytes验证，不能仅凭键相同视为幂等。

`v3_operation_evidence_refs` 保存已提交 operation 的 ordered refs，主键为 `(operation_id, dispatch_index, sequence)`，并分别以 FK指向 operation与 evidence；`v3_journal_evidence_refs` 保存 pending journal recovery set 的 ordered refs，主键额外包含 revision，并以复合 FK指向 journal。每条 ref保存 `digest`、`byte_length` 与 `encoding`，因此 manifest／journal envelope 与 normalized refs 可做 ordered六元组精确对账；same-digest不同 sequence不会被去重。

Transaction A 在一个事务中写 evidence CAS、journal-v2 payload 与 journal refs。Transaction B 在另一个事务中写 canonical operation／tracks／timeline／operation refs，经完整 `hydrateManifest` strict validation后发布 summary并删除 journal。B失败时A recovery set完整保留；recovery先核 journal payload与normalized refs，再重跑B。GC把 committed operation refs与pending journal refs的并集作为 roots，先校验每份 envelope／normalized refs／entity，再删除真孤儿；任何 mismatch都在删除前 fail loud。

### 3.7 `v3_operation_summaries`

forward migration `001-operation-summary-projection` 创建的一行一 operation 窄型产品读投影。`operation_id` 以 `ON DELETE CASCADE` FK 指向 `v3_operations`；canonical detail／export 仍以 `v3_operations.manifest_gz`、CAS与normalized evidence refs为权威。

| 列组 | 列 | 语义 |
|---|---|---|
| 身份／状态 | `operation_id`、`projection_status`、`projection_error` | `projection_status` 仅允许 `pending`／`ready`／`poisoned`；只有 ready row 进入产品 SQL 查询。repair 失败保留错误而不假装可读 |
| REST row codec | `summary_json` | `EntrySummary` JSON；list 页只解码选中的小页，不读取 canonical manifest |
| 排序／分组 | `operation_kind`、`session_id`、`agent_id`、`started_at`、`ended_at` | 支持 operation kind、双向 `(started_at,operation_id)` keyset、session 聚合和 agent 过滤 |
| 过滤／统计 | `endpoint`、`state`、`pid`、`request_model`、`response_model`、`response_success`、`duration_ms`、四个 token 列 | list／count／sessions／stats 共用的 typed SQL 维度；`state` 优先于兼容 `success` |
| 展示／可变投影 | `preview_text`、`response_preview_text`、`pinned` | 列表预览与 debug pin；pin 从父表单写并由 trigger 同事务投影 |

索引：

- `idx_v3_operation_summaries_created(started_at DESC, operation_id DESC)`：默认／generation list keyset。
- `idx_v3_operation_summaries_kind_created(operation_kind, started_at DESC, operation_id DESC)`：指定 bypass kind。
- `idx_v3_operation_summaries_session(session_id, started_at DESC, operation_id DESC)`：session 明细 keyset 与聚合。

forward migration `002-summary-integrity-invalidation` 在同一 migration transaction内先撤销旧 ready marker、把既有 summary rows统一重置为 `pending`并清旧错误，再安装完整 canonical invalidation trigger矩阵。Operation INSERT创建pending row并撤 marker；受保护 canonical字段变化或被引用 evidence变化会 poison依赖 summary并撤 marker；pin只同步 overlay；delete清 operation refs与summary；operation/evidence identity rename显式拒绝。合法 Transaction B在同一事务中完成 strict validation与summary发布，避免暴露pending中间态。

`initHistory()` 在 migrations与journal recovery之后异步启动 `startV3SummaryBackfill`。缺失summary row先按 keyset小批创建；旧 `summary_json IS NULL` 行从 canonical hydrate生成。最终 canonical-owner `validateAndMarkSummaryProjectionReady()` 在一个 `BEGIN IMMEDIATE` transaction内逐 operation复用完整 `hydrateManifest`：核manifest format／operation digest／CAS／normalized evidence refs／evidence bytes，合法项从当前 record＋`pinned`／`ended_at`／`timing_source`重投影并置ready，失败项置poisoned；只有全库零divergence、零pending、零poison时才写 `history_meta.summary_projection_ready=1`，否则删除marker。无副作用 `inspectSummaryProjectionReadiness()` 仅用于诊断派生层覆盖／字段／状态，不具备发布authority。

产品get／list／cursor／sessions／stats用 `withValidatedSummarySnapshot()` 在同一个短同步SQLite read transaction内绑定marker与全部窄SQL；marker缺席时走canonical fallback。Full-text search在await sidecar之后开启新的短snapshot复核marker并按IDs hydrate，不跨await持transaction。`/api/status` 的总数独立对 canonical `v3_operations` 做专用 `COUNT(*)`；memory状态另暴露 ready／pending／poisoned。

`v3_operations.summary_json`／`pinned`与canonical fallback仍保留，属于当前运行架构，不应误解为summary表拥有canonical authority。

### 3.8 `v3_tracks`

每条记录描述一条有序逻辑轨。payload/frame 值不在本表重复保存，`refs_json` 只存 operation-local handle。

| 列 | 类型 | 约束 | 语义 |
|---|---|---|---|
| `operation_id` | `TEXT` | `NOT NULL`，FK → `v3_operations(operation_id) ON DELETE CASCADE` | 所属 operation |
| `track_name` | `TEXT` | `NOT NULL` | 轨名 |
| `attempt_index` | `INTEGER` | `NOT NULL` | `-1` 表示 operation 级；`0..N` 表示 attempt |
| `refs_json` | `TEXT` | `NOT NULL` | 紧凑 handle refs；兼容旧 schema／无 `track_gz` 行的 fallback |
| `track_gz` | `BLOB` | nullable | format-v2 完整 `OperationTrack`（refs、metadata、frame observations），zstd 压缩 |

主键：`(operation_id, track_name, attempt_index)`。

当前轨名：

| `track_name` | `attempt_index` | 内容 |
|---|---:|---|
| `client-ingress` | `-1` | client → proxy 原始 semantic request |
| `effective-request` | `0..N` | proxy 内部 rewrite/sanitize 后请求 |
| `upstream-request` | `0..N` | proxy → upstream wire semantic request |
| `upstream-response` | `0..N` | upstream → proxy response payload/frame sequence |
| `upstream-egress` | `-1` | operation 级最终 upstream 轨 |
| `client-egress` | `-1` | proxy → client 实际 delivery 轨 |

未改写的 upstream/client frame 可以共享同一个 arena node；rewrite/filter/translation/synthetic 输出使用 derived node，并在 manifest 的 transform/provenance 数据中记录来源。

format-v2／v3 manifest 中同位置只保留空的结构占位，读取时按 `(track_name, attempt_index)` 从 `track_gz` 恢复完整轨，避免 request/response metadata 在 manifest 中重复。`track_gz IS NULL` 的 format-v1 行仍从 `refs_json` 读取。

### 3.9 `v3_timeline_chunks`

按 sequence 排序的生命周期事件块，每块最多 128 个事件。

| 列 | 类型 | 约束 | 语义 |
|---|---|---|---|
| `operation_id` | `TEXT` | `NOT NULL`，FK → `v3_operations(operation_id) ON DELETE CASCADE` | 所属 operation |
| `chunk_index` | `INTEGER` | `NOT NULL` | 从 0 开始的块序号 |
| `first_sequence` | `INTEGER` | `NOT NULL` | 块内首 sequence |
| `last_sequence` | `INTEGER` | `NOT NULL` | 块内末 sequence |
| `payload_gz` | `BLOB` | `NOT NULL` | timeline JSON array 的 zstd 压缩结果 |

主键：`(operation_id, chunk_index)`。timeline 包含 payload/frame 注册、transform、attempt 开始、diagnostic、attempt settle、terminal 等事件。

### 3.10 `v3_journal`

单写者的 crash-recovery journal。正常成功提交后对应行被删除，因此健康库通常为空。

| 列 | 类型 | 约束 | 语义 |
|---|---|---|---|
| `operation_id` | `TEXT` | `NOT NULL` | operation ID |
| `revision` | `INTEGER` | `NOT NULL` | terminal revision |
| `digest` | `TEXT` | `NOT NULL` | 预期 operation digest |
| `phase` | `TEXT` | `NOT NULL` | 当前写 `terminal` |
| `payload_gz` | `BLOB` | `NOT NULL` | **自包含、含 arena values** 的完整 terminal record，zstd 压缩 |
| `created_at` | `INTEGER` | `NOT NULL` | journal append epoch ms |
| `committed_at` | `INTEGER` | nullable | schema 保留字段；当前成功路径直接删 journal 行 |
| `error` | `TEXT` | nullable | recovery 失败原因 |
| `format_version` | `INTEGER` | `NOT NULL DEFAULT 1` | journal envelope版本；新写入为2，既有v1保持可恢复 |

主键：`(operation_id, revision)`。

提交顺序：事务外 prepare／hash／compress → Transaction A原子写 evidence CAS、self-contained journal-v2 payload与journal refs → Transaction B原子写 CAS objects、operation、tracks、timeline、operation refs，strict hydrate后发布summary并删除journal。若B失败，A recovery set独立留存；下次 `initHistory()` 调 `recoverV3Journal()` 查询 `committed_at IS NULL` 的行，先按 `format_version` 解 envelope并与normalized journal refs精确对账，再重建prepared artifacts、校验 revision／digest后重放B。Tantivy不参与此事务，其失败绝不回滚semantic History。

### 3.11 `v3_summary_backlog`

| 列 | 类型 | 约束 | 语义 |
|---|---|---|---|
| `operation_id` | `TEXT` | `PRIMARY KEY` | 无法生成 `summary_json` 的 V3 operation |
| `reason` | `TEXT` | `NOT NULL` | hydrate／projection 失败原因 |
| `updated_at` | `INTEGER` | `NOT NULL` | 最近失败时间 |

后台按小批次扫描 `summary_json IS NULL` 的 V3 行；失败行进入该 poison backlog，避免每次启动无限重试。backfill 只写派生 summary，不修改 digest、manifest 或 canonical CAS。
`getV3StoreStatus()` 同时返回 `summaryBacklog` 计数，供运行状态消费者识别 summary 派生降级。

## 4．`raw.db` schema

`raw.db` 是可选 exact-byte sidecar。每个 operation 创建时获取当前 store generation lease，后续配置切换不会改变该 operation 的目标文件；terminal 后 release，退役 generation 的最后一个 lease 释放时关库。

### 4.1 `raw_store_identity`

| 列 | 类型 | 约束 | 语义 |
|---|---|---|---|
| `store_id` | `TEXT` | `PRIMARY KEY` | artifact 的稳定 UUID；同路径重开保持不变 |
| `schema_version` | `INTEGER` | `NOT NULL` | 当前为 1 |
| `codec` | `TEXT` | `NOT NULL` | 当前固定 `zstd-json-v1` |

已有文件若没有 identity 表，或 schema/codec 不兼容，rotation 失败并保留原 active generation，不会把未知 SQLite 文件改写为 raw store。

### 4.2 `raw_objects`

| 列 | 类型 | 约束 | 语义 |
|---|---|---|---|
| `hash` | `TEXT` | `PRIMARY KEY` | exact bytes 的 SHA-256 内容键 |
| `kind` | `TEXT` | `NOT NULL` | capture 边界／编码种类，例如 `sse-frame-fields-v1` |
| `byte_length` | `INTEGER` | `NOT NULL` | 原始字节数 |
| `blob_gz` | `BLOB` | `NOT NULL` | 原始 bytes 的 zstd 压缩结果 |

hash 域为 `history-raw:${RAW_SCHEMA_VERSION}:${kind}\0` 加原始 bytes。hash 命中仍解压并做完整字节比较。

### 4.3 `raw_refs`

| 列 | 类型 | 约束 | 语义 |
|---|---|---|---|
| `operation_id` | `TEXT` | `NOT NULL` | semantic V3 operation ID；跨数据库逻辑引用，无 SQL FK |
| `sequence` | `INTEGER` | `NOT NULL` | operation 内 sequence |
| `track` | `TEXT` | `NOT NULL` | capture 轨／边界，例如 `upstream-frame`、`client-frame` |
| `object_hash` | `TEXT` | nullable | 成功时引用 `raw_objects.hash` |
| `capability` | `TEXT` | `NOT NULL` | `available`、`unavailable`、`not-requested` |
| `status` | `TEXT` | `NOT NULL` | `captured`、`disabled`、`failed`、`too-large`、`released` |
| `error` | `TEXT` | nullable | 失败或 gap 说明 |

主键：`(operation_id, sequence, track)`。使用 `INSERT OR REPLACE`，同一 operation sequence/track 的最终 capture 状态唯一。

raw capture 的失败、超大对象或数据库故障不会回滚 semantic V3，也不会阻断模型响应；状态通过 `/api/status.history_raw_capture` 暴露。

## 5．编码、引用与读取

| 数据 | 存储位置 | 编码 | 压缩 |
|---|---|---|---|
| Semantic payload/frame/sequence item | `v3_objects.canonical_gz` | sorted-key canonical JSON bytes | zstd |
| Sequence prefixes | `v3_sequence_nodes` | parent/item hash + depth | plain columns |
| Operation structure/provenance | `v3_operations.manifest_gz` | format-v3 value-free manifest + handle hashes + sequence roots/overlays + ordered evidence refs | zstd |
| Ordered logical tracks | `v3_tracks.track_gz` | 完整 `OperationTrack` JSON；`refs_json` 为兼容 fallback | zstd |
| Transport evidence | `v3_transport_evidence.evidence_gz` | exact binary bytes；digest／length／encoding逐项验证 | zstd |
| Normalized evidence refs | `v3_operation_evidence_refs`／`v3_journal_evidence_refs` | ordered dispatch／sequence／digest／length／encoding | plain columns |
| Product list summary | `v3_operation_summaries.summary_json` | canonical-owner strict repair同源生成的 `EntrySummary` JSON | plain |
| Timeline | `v3_timeline_chunks.payload_gz` | sequence-ordered JSON chunk | zstd |
| Crash journal | `v3_journal.payload_gz` | self-contained terminal record + ordered evidence refs；新写入journal format 2 | zstd |
| Raw object | `raw_objects.blob_gz` | exact bytes | zstd |

Detail读取先解压manifest、验证operation digest及format-v3 normalized evidence refs／entity，再批量读取arena object hashes；每个extracted sequence root用recursive CTE展开prefix chain，再批量补读缺失item objects并应用occurrence overlays；最后从 `track_gz` 恢复完整轨。对象读取不是逐item N+1，但当前每个sequence root有一次recursive CTE。`pinned` 从 `v3_operations` 单写、同步投影到窄表，不写回manifest。ready marker后list／sessions／stats在同一read snapshot内只读 `v3_operation_summaries`；session detail先在窄表选一小页operation IDs，transaction结束后再批量hydrate canonical detail。

## 6．SQLite connection 约定

Semantic V3 连接由共享 SQLite driver 打开，并执行：

- `PRAGMA auto_vacuum = INCREMENTAL`
- `PRAGMA journal_mode = WAL`
- `PRAGMA synchronous = NORMAL`
- `PRAGMA busy_timeout = 5000`
- `PRAGMA foreign_keys = ON`

Raw generation 连接执行：

- `PRAGMA journal_mode = WAL`
- `PRAGMA synchronous = NORMAL`
- `PRAGMA busy_timeout = 5000`

当前 raw 连接不设置 `auto_vacuum` 或 `foreign_keys`：schema 本身没有 FK，manager 当前也没有 raw-object 删除路径。若未来加入删除／保留策略，必须同时定义孤儿引用与空间回收协议，不能假定 raw.db 会自动把空闲页归还给 OS。

Bun 使用 `bun:sqlite`，Node 使用 `node:sqlite`，统一抽象在 [`packages/foundation/src/sqlite/driver.ts`](../packages/foundation/src/sqlite/driver.ts)。SQLite transaction callback 必须同步，事务内不得跨 `await`。

## 7．运维查询

```sql
-- History V3 表与索引
SELECT type, name, tbl_name, sql
FROM sqlite_schema
WHERE name LIKE 'v3_%' OR name = 'history_store_identity'
ORDER BY type, name;

-- 最近 terminal operations
SELECT operation_id, kind, revision, terminal_sequence, pinned, created_at, committed_at
FROM v3_operations
ORDER BY created_at DESC, operation_id DESC
LIMIT 20;

-- CAS 压缩率
SELECT
  COUNT(*) AS objects,
  SUM(canonical_bytes) AS canonical_bytes,
  SUM(LENGTH(canonical_gz)) AS compressed_bytes
FROM v3_objects;

-- 正常应为空；非空表示等待恢复或 recovery 失败
SELECT operation_id, revision, phase, created_at, committed_at, error
FROM v3_journal
ORDER BY created_at;

-- summary projection readiness 与失败
SELECT projection_status, COUNT(*) AS operations
FROM v3_operation_summaries
GROUP BY projection_status;

SELECT operation_id, projection_status, projection_error
FROM v3_operation_summaries
WHERE projection_status <> 'ready'
ORDER BY started_at, operation_id;

SELECT operation_id, reason, updated_at
FROM v3_summary_backlog
ORDER BY updated_at DESC;

-- raw capture generation 身份
SELECT store_id, schema_version, codec FROM raw_store_identity;

-- raw capture gap
SELECT operation_id, sequence, track, capability, status, error
FROM raw_refs
WHERE capability <> 'available'
ORDER BY operation_id, sequence;
```

不要对运行中数据库做跨多表的非事务拼装并把结果当作一致快照；产品读取应优先走 `/history/api/*`。直接查库适合 schema 检查、容量分析和故障取证。

## 8．Schema 演进规则

1. `history-v3.db`、`raw.db` 与 Tantivy `history-search/` 各有独立 artifact identity，不允许用 live config 把既有 artifact 按另一套 schema 解释。
2. 新增 authoritative 字段时，先更新 backend-owned `ModelOperationRecord`，再更新 manifest/store/projection；不能从 REST/UI DTO 反向定义 producer 数据。
3. 新增大对象优先进入 CAS；manifest 与 tracks 只保存结构和引用，避免重复 payload/frame bytes。
4. 全文搜索不得在 `history-v3.db` 建表、存 document 或参与 authoritative transaction；Tantivy 失败只更新独立 runtime status。
5. journal 必须保持自包含；不能依赖可能与 operation transaction 一起回滚的 CAS rows。
6. raw config 的 `enabled`、`db_path`、`max_object_bytes` 只影响新 acquisition；旧 lease 始终按冻结 generation 完成并 drain。
7. Legacy `history.db` / `archive.db` 的任何迁移、归档、删除或格式适配都不属于在线 History V3 schema 生命周期。
8. format-v1／v2 manifest与journal-v1必须保持可读；新manifest格式使用独立hash domain，schema reconcile不自动重写已有operation。
9. manifest reader接受format 1／2／3；journal reader接受format 1／2。对非整数、无效或高于当前实现的version fail loud，不猜测未来布局。
10. Evidence GC必须先对manifest／journal envelope与normalized refs逐项对账，并验证所有root entities；任一失败都在删除前中止。Clear必须在同一transaction清canonical rows、两类refs、evidence entities与summary readiness marker，保留schema metadata。

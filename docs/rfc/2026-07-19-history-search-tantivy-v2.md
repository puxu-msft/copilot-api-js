# History Search Tantivy V2：内容单元索引、可恢复回填与产品查询切换

- **状态**：PROPOSED
- **日期**：2026-07-19
- **前置版本**：[History search Tantivy sidecar v1](../history-search-tantivy.md)
- **权威数据源**：`history-v3.db` 中已提交的 `ModelOperationRecord`

## 1. 背景与问题

Tantivy v1 已完成两个必要动作：

1. `history-v3.db` schema v5 删除全部 `v3_search_*` 表，全文搜索不再参与 History 权威事务；
2. 独立 `history-search/` sidecar 能实时接收新 terminal operation，并由 Rust/Tantivy 建立一个 operation 一个 document 的实验性索引。

但 v1 不能直接成为产品搜索：

- HTTP 搜索接口仍按决策返回空数据；
- 没有对已有 V3 operation 的 backfill；
- 每个 operation 重新索引完整 arena JSON，会重复长对话前缀；
- 每条 operation 都重开 `IndexWriter` 并 commit，segment/IO 成本不可接受；
- 默认 Tantivy query parser 暴露语法且不提供旧产品需要的稳定 Unicode substring 语义；
- 没有与具体 `history-v3.db` artifact 绑定的 store identity、持久 watermark、原子 generation 切换和 cursor 稳定性；
- 当前索引可能先于 V3 commit 成功，理论上可产生 orphan hit；
- native 发布只有构建主机平台 binary，不能作为跨平台产品能力。

真实只读统计（2026-07-19）进一步否决“直接索引整个 operation JSON”：

- 3,736 terminal operations（3,672 generation、64 count_tokens）；
- 317,400 semantic objects；
- payload canonical JSON 总量约 6.29 GB，压缩后约 1.92 GB；
- object p99 约 724 KB，最大 payload 约 2.75 MB；
- 大量长对话只在尾部新增消息，operation 级全文重复会重新制造存储放大。

## 2. 冻结目标

V2 必须同时满足：

1. **History 零搜索内容**：不在 `history-v3.db` 新增全文 document、token、posting、membership 或 search backlog。
2. **只索引已提交数据**：Tantivy 的输入必须来自成功提交的 V3 operation；不能以 terminal publication 代替 durable commit。
3. **内容单元去重**：同一 normalized semantic fragment 跨 operation 只保存一份可展示文本。
4. **产品结果以 operation 为中心**：查询返回匹配的请求／operation，不返回“最早 owner message hash”这类旧索引内部概念。
5. **可恢复且 eventual-complete**：实时漏写、进程崩溃、native 暂时不可用都可从 V3 自动 reconcile，不要求搜索写入阻塞模型请求。
6. **无假阴性伪装**：索引未 ready 时不能把“未索引”伪装成“确实无结果”。
7. **Unicode literal substring**：默认查询是用户字面量，不暴露 Tantivy query grammar；中英文均支持至少 2 个 Unicode scalar 的连续子串匹配。
8. **有界资源**：writer queue、projection bytes、matched content units、分页深度均有硬上限和显式降级标记。
9. **跨平台可发布**：正式 API cutover 前必须有受支持平台的预编译 N-API matrix；安装时不要求最终用户有 Rust。

## 3. 非目标

V2 不做：

- 搜索 legacy `history.db`、`archive.db` 或 seal；
- 索引 exact raw bytes、HTTP header、Authorization、cookie、图片/base64、thinking signature/encrypted payload；
- 外部 daemon、Elasticsearch、Meilisearch 或网络搜索服务；
- 模糊拼写、向量检索、语义 embedding、正则表达式；
- relevance 深分页；
- 把 Tantivy 结果当作权威 History 数据。

## 4. 产品搜索语义

### 4.1 搜索范围

废弃旧的五个物理 facet（`inbound`、`rewrites-req`、`rewrites-resp`、`req-headers`、`resp-headers`）。新 scope 是稳定产品语义：

| Scope | 内容 |
|---|---|
| `request` | client ingress 的 system/messages/text/tool declarations；不重复 effective/upstream request |
| `response` | 实际 client egress 的文本、thinking 明文、tool output；stream frame 按 semantic handle 去重 |
| `tools` | tool name、可读 input arguments、tool result 文本 |
| `diagnostics` | terminal outcome、attempt error、status、stop reason 与 diagnostic message |
| `all` | 上述四域并集（默认） |

Headers 和 raw wire bytes 明确不进入任何 scope。Rewrite/provenance 仍可在 History detail 中诊断；未来如确有需求，新增独立 `debug` scope，而不是复活旧 SQLite facet。

### 4.2 字面查询

默认 `q` 是字面文本：

- Unicode NFKC；
- CRLF/多空白折叠为单空格；
- case-insensitive；
- 最短 2 个 Unicode scalar，最长 256；
- 不解释 `+ - : ( ) * "` 等 Tantivy grammar；
- 连续 substring 才算命中。

索引内容与 query 必须调用同一份、版本化的 normalization 规格：NFKC → CRLF/Unicode whitespace 折叠为 U+0020 → Unicode lowercase/case-fold contract。JS 与 Rust 的 normalization/hash golden 是 release gate；任一实现发生变化都必须 bump `projectionVersion` 并 fresh rebuild，不能让两个版本并行写同一 generation。

索引注册两个 tokenizer：

1. `terms_v1`：Unicode word/simple tokenizer + lowercase，用于 BM25 辅助评分；
2. `grams_v1`：2–3 scalar n-gram + lowercase + positions，用 phrase query 保证连续 substring，覆盖 CJK 与单词内部匹配。

查询以 `grams_v1` phrase 为召回门槛，`terms_v1` 只提供 boost，不能扩大结果集。单字符查询返回结构化 400 `query_too_short`，避免 unigram 索引膨胀。

Tantivy 0.26 的 `NgramTokenizer` position 行为不能只靠推断。Phase 3 必须用实际 tokenizer/phrase query 证明 CJK、Latin、组合字符、标点和跨 whitespace 的正负样本；任何一项出现 false negative，就在产品接线前改为仓库自有 Unicode-scalar tokenizer。这里的“scalar”明确是 normalization 后的 Unicode scalar，不是 UTF-8 byte 或 grapheme cluster。

### 4.3 投影与限额

新增唯一 owner：`src/lib/history/search/projection.ts`，输出：

```ts
interface SearchProjectionV2 {
  operation: SearchOperationMetadata
  units: Array<SearchContentUnit>
  truncated: boolean
  omittedBytes: number
}

interface SearchContentUnit {
  hash: string
  scope: "request" | "response" | "tools" | "diagnostics"
  text: string
}
```

`hash = SHA-256("history-search:projection-v2:<scope>\0" || normalized UTF-8 text)`。

提取规则：

- 以 canonical track/arena handle 为边界，同一 operation 内先按 handle 和 unit hash 去重；
- message/content block/frame 逐逻辑单元切分，不把 2.7 MB request body 当一个 unit；
- `cache_control`、`ephemeral`、ID-only 字段、签名、encrypted content、binary/image/base64 被排除；
- unknown extension 只索引明确 string leaf，不能递归吞入任意大对象；
- 每 unit 最多 256 KiB normalized UTF-8；
- 每 operation 最多 4,096 units、8 MiB index input；
- 超限截断必须记录 `truncated/omittedBytes`，进入 status 与搜索响应，不能静默宣称完整。

`truncated/omittedBytes` 是 **per operation**：只要任一 unit 被全部或部分丢弃，`truncated=true`；`omittedBytes` 是 normalization 后未进入索引的 UTF-8 bytes 总和。batch manifest 保留每个 operation 的标记，不存在 batch 级布尔值。`responses_ws`/stream frames 按 sequence 在逻辑 frame/content-block 边界切 unit；达到 8 MiB 时只在 unit 边界截断，并累计后续 unit bytes。

## 5. Tantivy V2 物理模型

同一 index 内使用两类 document，通过 `doc_type` 区分。

### 5.1 Content document（跨 operation 去重）

| Field | 类型 | 属性 | 说明 |
|---|---|---|---|
| `doc_type` | STRING | indexed | 固定 `content` |
| `content_hash` | STRING | indexed + stored | projection-v2 identity |
| `scope` | STRING | indexed | request/response/tools/diagnostics |
| `text_terms` | TEXT | indexed | `terms_v1` |
| `text_grams` | TEXT | indexed + positions | `grams_v1` |
| `snippet_text` | TEXT/bytes | stored | normalized text；Tantivy store 压缩，只保存一份 |

Content document 不携 operation ID。相同 scope + normalized text 跨所有 operation 只存在一行。运行时 writer 对 committed term dictionary + 当前 batch hash set 做存在性检查；重复 hash 不重写。

### 5.2 Operation document（小型 membership + filters）

| Field | 类型 | 属性 | 说明 |
|---|---|---|---|
| `doc_type` | STRING | indexed | 固定 `operation` |
| `operation_id` | STRING | indexed + stored | 唯一 identity；upsert 先 delete term |
| `content_ref` | STRING[] | indexed + stored | 此 operation 引用的 content hashes |
| `order_key` | STRING | indexed + fast + stored | reverse-created-at + operation ID，稳定 newest keyset |
| `created_at` / `committed_at` | u64 | fast + stored | 排序、freshness |
| `operation_kind` | STRING | indexed + stored | generation/count_tokens/... |
| `model` / `endpoint` / `outcome` | STRING | indexed + stored | 结构过滤 |
| `session_id` / `agent_id` | STRING | indexed + stored | 结构过滤；缺省写空 term |
| `pid` | i64/u64 | fast + indexed | 结构过滤 |
| `projection_truncated` | bool/u64 | fast + stored | 结果诚实性 |

Operation document 不复制全文，只保存 hash membership 和小型 metadata。

### 5.3 两阶段查询

1. 在 content docs 上执行 literal substring + scope，得到 matched `content_hash → score/snippet`；
2. 用 `TermSetQuery(content_ref ∈ matched hashes)` 查询 operation docs，同时应用 metadata filters；
3. 第一版只支持 `sort=newest`，按 `order_key` keyset 分页；
4. 对返回 operation 的 refs 与 matched hash 取交集，返回最多 3 个 snippet 和 `matchedScopes`；
5. backend 按 operation ID 批量读取 V3 `summary_json`，不存在的 stale hit 被过滤并排入 sidecar delete/reconcile。

native 先用 Count collector 判定 content match cardinality，再收集完整 doc set。超过 50,000 个 content hashes 时不返回任意子集，而是返回结构化 422 `query_too_broad`，要求增加字符或 filters；这避免相同 score 下 TopDocs 截断造成不确定假阴性。`sort=relevance` 等到实现可证明稳定的跨 content→operation score 聚合后再开放；V2 的 ranking 明确是 newest-only。

## 6. Artifact 与 generation

V2 不在 v1 root index 上原地升级。目录布局：

```text
history-search/
  OWNER.json
  CURRENT
  generations/
    g-<uuid>/
      manifest.json
      tantivy files...
  building/
    g-<uuid>/...
```

`OWNER.json`：

```json
{
  "owner": "copilot-api-history-search",
  "sourceStoreId": "<history-v3 stable UUID>",
  "artifactVersion": 2
}
```

为正确绑定 artifact，History V3 需要在 `v3_meta` 增加稳定随机 `store_id`。这只是权威 store identity，不包含搜索 document/membership。

Generation manifest 至少包含：

- `generationId`；
- `schemaVersion`；
- `indexFormatVersion`；
- `projectionVersion`；
- tokenizer 的完整定义和值 fingerprint（min/max gram、normalization、position contract）；
- `sourceStoreId`；
- `indexedThroughSeq` 与 `targetThroughSeq`；
- Tantivy commit opstamp；
- build start/end time、operation/unit counts、truncation counts。

Manifest 另有 `operationProjectionState: Record<operationId,{revision,digest,truncated,omittedBytes}>`，或语义等价的分片文件；它与对应 Tantivy commit 一起发布，不能只保存聚合 truncation count。

构建完成顺序：Tantivy commit → fsync generation files → fsync generation directory → 写并 fsync `CURRENT.tmp` → 平台原子 replace `CURRENT` → fsync root directory（平台支持时）。POSIX 使用同目录 rename；Windows 使用 `ReplaceFileW`/等价 overwrite 原语并带有限退避，禁止 delete-then-rename 暴露无 CURRENT 窗口。每次 native search 获取 `Arc<Generation>`，lease 覆盖整个 N-API search Promise/HTTP query，Promise settle 时由 Rust Drop 释放；切换只影响新 query。旧 generation 进入 GC pending set，只在 lease count=0 后由 writer maintenance 删除。崩溃遗留的 `building/` 只在 identity 匹配时清理。

Generation manifest 有 `buildState: preparing|backfilling|catching-up|committing|complete`，只允许顺序前进。重启遇到非 complete build 时，第一版将该 owned building generation 标 abandoned、删除后创建新 generation，并从 durable active manifest 的 `indexedThroughSeq+1`（无 active 时从 1）重新扫描；禁止把半成品设为 CURRENT。schema/projection/tokenizer/sourceStoreId 任一不匹配都必须 fresh generation，不能原地打开。

v1 sidecar 被视为可丢弃派生。V2 首次成功 cutover 后，才删除明确由 v1 `FORMAT` marker 拥有的旧文件；未知目录永不覆盖或删除。

## 7. Commit 后索引与有界 writer

### 7.1 禁止 terminal-before-commit

新增 V3 committed notification，只在 `commitPreparedOperation()` 成功后发布：

```ts
interface V3CommittedOperation {
  record: ModelOperationRecord
  committedAt: number
  commitSeq: number
  canonicalRecordZstdV1: Uint8Array
}
```

Tantivy 订阅 committed notification，不再直接订阅 terminal bus。若 V3 commit 失败，搜索绝不能出现该 operation。

`canonicalRecordZstdV1` **精确定义**为当前 journal 使用的 `compressBytes(UTF8(JSON.stringify(ModelOperationRecord)))`，是完整、自包含 terminal record，不是 value-free manifest，也不要求事后查询 CAS。V3 prepare 只生成一次，同一 bytes 同时供 crash journal 与 commit 后派生 consumer 使用；codec/version 是 committed-feed contract 的一部分。native Rust 解压／解析／projection；TypeScript projection 仅作为 oracle/golden，生产与 Rust extractor 必须过 byte-equivalent fixtures。

### 7.2 长生命周期 native handle

N-API 改为 class/handle：

```ts
class NativeSearchIndex {
  static open(path, config): Promise<NativeSearchIndex>
  addBatch(operations): Promise<CommitInfo>
  deleteOperations(ids): Promise<CommitInfo>
  search(request): Promise<NativeSearchPage>
  commit(): Promise<CommitInfo>
  close(): Promise<void>
}
```

每 generation 只创建一个 `IndexWriter`、`IndexReader`。writer 按以下任一条件 batch commit：

- 64 operations；
- 16 MiB compressed input；
- 2 秒；
- shutdown/barrier。

禁止每 operation 重开 50 MB writer/commit。

### 7.3 队列

JS/native 总队列硬上限：

- 256 operations；
- 64 MiB compressed input；
- 取先达到者。

搜索是派生能力，队列满时不阻塞模型请求：丢弃 sidecar task，设置 `needsReconcile=true` 和最早缺口 cursor。后台 reconciler 从 V3 补齐。状态必须暴露 dropped/reconciled 计数。

## 8. Backfill 与一致性

### 8.1 数据源

只读 `history-v3.db`，绝不打开 legacy `history.db`。为消除毫秒时间并列和“snapshot 后插入但 operation_id 更小”的根本歧义，V3 增加通用 authoritative commit ledger：

```sql
v3_operation_commits(
  commit_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE REFERENCES v3_operations(operation_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  committed_at INTEGER NOT NULL
)
```

这不是搜索 document/membership，而是 canonical operation 的全局 durable commit order，可供所有派生 consumer 使用。operation 与 ledger row 在同一 V3 transaction 中提交；existing rows 在 schema reconcile 时按 `(committed_at, operation_id)` 一次性赋初始 seq。之后 backfill/watermark 只用 `commit_seq`，不再用时间重叠猜测。Search upsert identity 是 `(operation_id, revision, digest)`；完全相同为幂等，非预期 revision/digest 变化 fail-loud。

新增 V3 reader 按 `commit_seq ASC` bounded keyset 分页；upper watermark 是启动 build 时 durable `MAX(commit_seq)`。

### 8.2 Fresh rebuild

1. 先安装 committed subscriber并缓冲 `commit_seq > indexedThroughSeq`；
2. 创建 `building/g-*`；
3. 捕获 V3 upper watermark；
4. 低优先级按 commit_seq 分页扫描 `<= upper`；
5. 合并 subscriber buffer，并扫描 `(upper, latest]` catch-up（两者都幂等）；
6. 进入短 barrier：drain V3 writer，捕获 final watermark，补最后 delta；
7. Tantivy commit/fsync；
8. 原子切换 `CURRENT`；
9. 将 barrier 后的新 committed batch 写 active generation；
10. 无 lease 后 GC 旧 owned generation。

Fresh build 失败不影响旧 ready generation。没有 ready generation 时，API 明确报告 `building/unavailable`。

### 8.3 Incremental reconcile

Active manifest 的 `indexedThroughSeq` 只在一个**连续 commit_seq 前缀**的对应 batch Tantivy commit 成功后推进。queue overflow 设置 `firstDroppedSeq=min(dropped seq)`；reconcile 从 `min(indexedThroughSeq+1, firstDroppedSeq)` 重扫。启动、queue drop、native 恢复后都按 seq 补齐；upsert 保证 at-least-once 安全。batch 中任一 operation 失败时不能越过它推进 contiguous watermark。

当前生产没有 operation delete。未来若增加 delete，必须先提供 committed tombstone/change-log；在此之前 stale hit 由 backend “V3 summary 不存在”过滤，下一次 full rebuild 永久清除。

## 9. API cutover

### 9.1 请求

继续使用 `GET /history/api/search`，但切换为 operation-centric contract：

```text
q=<literal>                    required
scope=all|request|response|tools|diagnostics  default all
operationKind=all|generation|responses_ws|count_tokens|embeddings
model=&endpoint=&state=&sessionId=&agentId=&pid=&from=&to=
sort=newest                    V2 only
limit=1..100                   default 30
cursor=<opaque signed/base64url payload>
```

旧 `source` 参数在一个兼容周期映射：`inbound→request`、`rewrites-resp→response`；其余旧 source 返回 400 `unsupported_legacy_scope`，不伪造等价结果。UI 同批切到 `scope`。

`/search/contains` 不再符合 operation-centric 模型；UI 切换后返回 410 并在下一 major 删除。当前空响应阶段保持不变。

### 9.2 响应

```ts
interface SearchPageV2 {
  rows: Array<{
    operationId: string
    summary: EntrySummary
    matchedScopes: Array<SearchScope>
    snippets: Array<{ scope: SearchScope; text: string; highlights: Array<[number, number]> }>
    projectionTruncated: boolean
  }>
  nextCursor: string | null
  partial: boolean
  partialReason?: "building" | "lagging" | "projection_truncated"
  index: {
    state: "ready" | "building" | "degraded"
    generationId?: string
    indexedThroughSeq?: number
    targetThroughSeq?: number
    lagOperations?: number
    lagMs?: number
  }
}
```

状态规则：

- 有 ready generation：返回结果；若 lagging，`partial=true`；
- 正在 rebuild 且旧 generation ready：继续服务旧 generation并标 stale；
- 没有任何 ready generation：返回 503 `search_unavailable`，不能用空 rows 冒充无匹配；
- cursor generation/query fingerprint 不匹配：409 `search_cursor_stale`，客户端从第一页重试；
- 当前（API 尚未 cutover）继续按用户决策返回空数据，不提前暴露半成品。

Cursor 固定携带 `{generationId, queryFingerprint, orderKey}`。`queryFingerprint = SHA-256(canonical JSON of normalized q + scope + filters + sort)` 全 256-bit base64url，不使用截断 hash。generation 或 fingerprint 不匹配统一返回 409 `search_cursor_stale`，绝不跨 generation 混页。`order_key = zeroPad(u64::MAX-created_at, 20) + ":" + operation_id`，第一页升序取前 limit，后续严格 `order_key > cursor.orderKey`；`operation_id` 不需单调，只需 operation 内唯一，字典序即稳定 tie-break，测试必须覆盖相同 created_at 与乱序 IDs。并发插入不会改变已发 cursor 的边界。

## 10. 状态与可观测性

`/api/status.history_search` 扩展：

- artifact/generation/projection/tokenizer version；
- `state: disabled|initializing|building|ready|degraded`；
- active/building generation；
- indexed/target watermark；
- lag operations/ms；
- queue operations/bytes/high-water；
- indexed operations/content units；
- dedup ratio（operation refs / unique units）；
- projection truncation count/omitted bytes；
- dropped/reconciled/failed operations；
- index bytes、segments、last commit/search latency、last error。

状态机固定为：

```text
disabled → initializing → building → ready
ready → building → ready               (旧 generation 持续服务)
任意状态 → degraded → building → ready  (native/下次启动自动恢复)
```

运行中手工删除 active sidecar 视为 corruption：当前进程进入 degraded，不在未知文件状态下原地重建；下一次显式 configure/restart 才 fresh build。

日志不得输出 searchable content、query 原文或 snippet；只记录 query 长度、scope、耗时、result count。

## 11. 安全与文件权限

- sidecar directory 创建为 owner-only（POSIX 0700），manifest/marker 0600；
- 不索引 headers/raw/token/signature/encrypted/base64；
- snippet 经 JSON transport，UI 必须纯文本 escape，不允许 `v-html` 注入；
- native panic 必须转换为 N-API error，不能 abort 代理进程；
- corrupt generation 不自动修补原文件：标 degraded，fresh build 新 generation，成功后切换。

## 12. 发布与兼容矩阵

API cutover 阻塞于预编译 binary：

- linux-x64-gnu；
- linux-arm64-gnu；
- darwin-x64；
- darwin-arm64；
- win32-x64-msvc。

loader 按 platform/arch/libc 选择精确文件并校验 native ABI/index format。npm consumer 不运行 Cargo。缺 binary 时代理继续运行，History 正常，search 状态 degraded；不能 fallback 到 SQLite。

## 13. 性能与验收门槛

### 正确性

- format-v1/v2 canonical records 投影到相同 SearchProjectionV2 golden；
- source/derived handle 重复不产生重复 unit refs；
- header/token/signature/image/base64 负样本不可搜索；
- CJK、大小写、标点、2-char、substring、特殊 query 字符通过；
- V3 commit failpoint 不产生 search hit；
- queue overflow、native crash、进程 crash 后 reconcile 最终零缺口；
- rebuild 期间 active generation 查询稳定，原子切换无混代 cursor；
- sidecar 删除后可只从 V3 全量重建。

### 资源与时延

在当前真实规模只读源和合成 100k operations 两档验证：

- ready search p95 < 100 ms，p99 < 250 ms（limit 30）；
- live indexing lag p95 < 5 s；
- JS event-loop 单次额外 stall < 10 ms；
- queue resident compressed bytes ≤ 64 MiB；
- full build RSS 有明确上限，不随 operation 总数线性驻留；
- sidecar bytes 必须打印 content-unit dedup ratio、bytes/op、bytes/unique-unit；未测量前不预先声称固定压缩倍数；
- broad query 超过 content-hash 上限时显式 422，不返回任意 partial 子集、不 OOM。

## 14. 被否决方案

1. **一个 operation 一个 stored full JSON**：长对话前缀重复，已由真实 6.29 GB payload 规模否决。
2. **只建 content docs，不建 operation membership**：Tantivy 无 join，无法稳定做 filters/pagination。
3. **把 membership 放回 SQLite**：重新耦合 History transaction/schema，违反冻结目标。
4. **暴露 Tantivy query parser**：语法注入、错误信息漂移、CJK/substring 语义不稳定。
5. **搜索写失败时阻塞模型请求**：派生能力不能反向治理权威请求路径。
6. **无 ready generation 时返回 200 空 rows**：把不可用伪装成无匹配；只允许当前明确的过渡期空接口。
7. **每 operation commit 一个 Tantivy segment**：writer memory/IO/merge 放大，v1 仅为接线验证。

## 15. 实施边界

实施拆为独立、可回滚的阶段，详见 [implementation plan](../plan/2026-07-19-history-search-tantivy-v2.md)。在 projection、generation、reconcile、binary matrix、API contract 和性能门全部通过前，现有 HTTP 搜索继续返回 empty data。

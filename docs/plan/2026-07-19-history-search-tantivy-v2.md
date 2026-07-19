# Tantivy V2 implementation plan

- **RFC**：[History Search Tantivy V2](../rfc/2026-07-19-history-search-tantivy-v2.md)
- **状态**：PLANNED
- **原则**：每阶段独立可测试、可提交；直到 Phase 7 完成，HTTP 搜索继续返回 empty data。

## 0. 基线与不可侵犯项

开始实现前固定：

- `history-v3.db` schema v5 不含 `v3_search_*`；
- legacy `history.db` 不打开、不读取、不修改；
- `GET /history/api/search` 与 `/search/contains` 当前空响应作为迁移期 golden；
- Tantivy v1 的真实 Bun/Node N-API smoke tests 保留；
- 真实数据库只允许 read-only benchmark，输出写临时目录。

每个 phase 都运行：

```bash
bun run typecheck
bun x eslint <changed-ts-files>
cargo fmt --manifest-path native/history-search/Cargo.toml -- --check
cargo clippy --manifest-path native/history-search/Cargo.toml --all-targets -- -D warnings
bun test <targeted-tests>
```

## Phase 1：SearchProjectionV2 单一事实源

### 目标

先定义“什么能被搜”，不改 native，不接 API。

### 新增／修改

- 新建 `src/lib/history/search/projection.ts`
  - `projectModelOperationForSearch(record)`；
  - scope-aware fragment extraction；
  - NFKC/whitespace normalization；
  - signature/encrypted/base64/header/binary 排除；
  - unit/operation limits；
  - projection-v2 SHA-256 domain。
- 新建 `src/lib/history/search/types.ts`
  - `SearchScope`、`SearchContentUnit`、`SearchProjectionV2`、watermark/status types。
- 不复用 legacy `sqlite/search-index-write.ts`；它属于不会打开的 V2 characterization tree。

### 测试

- `tests/history/search/projection.unit.test.ts`
  - 四 scope 正样本；
  - source/derived/track handle 重复去重；
  - generation/count_tokens/embeddings/responses_ws；
  - CJK/NFKC/CRLF；
  - projection 与 query 共享 NFKC→whitespace fold→case contract（CRLF/multi-space 互搜）；
  - cache_control/signature/encrypted/image/base64/header 负样本；
  - 256 KiB/unit、4,096 units、8 MiB/op 截断；
  - `truncated/omittedBytes` 按 operation 计算，responses_ws 在 unit 边界截断；
  - shared-reference JSON 与 unknown extension；
  - 不 mutation canonical record。
- `tests/history/search/projection-golden.unit.test.ts`
  - format-v1 fixture hydrate 与 format-v2 fixture hydrate 得到相同 projection。

### Commit

```text
feat(history-search): define canonical search projection
```

## Phase 2：V3 stable store identity 与 committed feed

### 目标

Tantivy 只消费已成功提交的 operation，并绑定到正确 V3 artifact。

### 修改

- `src/lib/history/v3/store.ts`
  - schema version bump；
  - `v3_meta.store_id` 首次生成稳定 UUID；
  - 新增与 operation 同事务写入的 `v3_operation_commits(commit_seq AUTOINCREMENT, operation_id UNIQUE, revision, digest, committed_at)`；旧行按 `(committed_at,operation_id)` 初始化；
  - `commitPreparedOperation()` 返回 `{ result, committedAt }` 或等价 typed result；
  - commit 成功后发布 `V3CommittedOperation`；
  - 提供 committed subscriber/drain/reset；
  - committed feed 精确携 `commitSeq + canonicalRecordZstdV1`，后者等于 journal 的完整 self-contained terminal record bytes；
  - 提供 `commit_seq` bounded keyset reader 和 upper-watermark query。
- `src/lib/history/state.ts`
  - Tantivy 从 terminal bus 迁到 committed feed；
  - shutdown 顺序：停止新请求 → drain terminal/V3 writer → detach committed feed → drain search。
- 移除 v1 `searchableContent(record)` 生产接线；native v1 direct test API可保留到 Phase 4。

### 正确性测试

- V3 commit failpoint：无 committed event；
- idempotent replay：事件语义明确（只首插发布，或携 idempotent flag）；
- journal recovery 成功后发布 committed event；
- store_id 重开稳定，不同 DB 不同；
- cursor ties、page boundary、upper watermark；
- commit_seq contiguous，无毫秒并列/new-lower-id 漏行；
- committed feed drain-before-close；
- real `history.db` owner guard 仍拒绝打开。

### Commit

```text
feat(history): publish durable V3 commit feed
```

## Phase 3：Native V2 schema、tokenizer 与 projection oracle

### 目标

实现 content/operation 双文档模型，但仍不接产品 API。

### Rust 修改

- 拆 `native/history-search/src/`：
  - `schema.rs`；
  - `projection.rs`；
  - `writer.rs`；
  - `query.rs`；
  - `artifact.rs`；
  - `lib.rs` 只保 N-API facade。
- 增加依赖：`unicode-normalization`、必要的 serde/zstd。
- 注册 `terms_v1` 与 `grams_v1`。
- 用真实 Tantivy 0.26 tokenizer/phrase query 锁 CJK/Latin/组合字符/标点的正负样本；若有 false negative，改仓库自有 Unicode-scalar tokenizer 后才继续；
- native 接收 V3 已有 compressed canonical record bytes，在 blocking worker 解压、parse、projection。
- TypeScript projection 与 Rust projection 对同 fixtures 输出 `{metadata, units}` byte-equivalent JSON。
- generation manifest 锁 `operationProjectionState[operationId]={revision,digest,truncated,omittedBytes}` exact shape。

### Native API（临时测试形态）

- `projectCanonicalRecord(bytes)`；
- `createV2Index(path, owner)`；
- `addProjectionBatch(path, projections)`；
- `inspectIndex(path)`。

### 测试

- Rust unit tests：normalization/hash/tokenizer/query literal；
- Bun integration：content hash 跨 operation 只一个 content doc，operation refs 两条；
- phrase n-gram 防非连续 false positive；
- 2-char CJK/Latin、casefold、特殊 grammar 字符；
- JS/Rust NFKC/hash 完全相同，任一 normalization drift 必须导致 projection version mismatch；
- unknown/corrupt compressed payload 返回 error 不 panic；
- content collision 做 full normalized bytes verification，不能只信 hash。

### Commit

```text
feat(history-search): add content-addressed Tantivy schema
```

## Phase 4：长生命周期 writer、batch 与有界队列

### 目标

退役 v1 每 operation open/writer/commit 模式。

### Native

实现 N-API `NativeSearchIndex` handle：

- 一个 active `IndexWriter` + reader；
- `addBatch`、`deleteOperations`、`commit`、`inspect`、`close`；
- 64 ops / 16 MiB / 2s batch trigger；
- native state 放 `Arc<Mutex<...>>` 或同等串行 owner；
- 所有 I/O/parse/projection 在 `spawn_blocking`；
- close 幂等，panic→N-API error。

### TypeScript

- 重写 `src/lib/history/search-tantivy.ts` 为有界 queue manager；
- queue 只持 compressed bytes + metadata，不持完整 record；
- 上限 256 ops / 64 MiB；
- overflow 标记最早 reconcile gap，不阻塞 producer；
- generation-aware configure/drain；
- counters：queued bytes/high-water/dropped/commit duration。

### 测试

- 1,000 operations 只产生受控 segment 数；
- timer/count/bytes/shutdown 四种 commit trigger；
- queue overflow 不阻断 V3 commit且设置 reconcile；
- rapid reconfigure 不跨 generation 写；
- close/reopen、native error、panic guard；
- RSS/queue bytes 有界；
- event-loop metronome max gap 门槛。

### Commit

```text
refactor(history-search): batch Tantivy writes behind bounded queue
```

## Phase 5：Artifact generations 与 recoverable backfill

### 目标

已有 V3 数据最终完整进入 sidecar，构建失败不破坏可查询 generation。

### 新增／修改

- `src/lib/history/search/artifact.ts`
  - OWNER/CURRENT/generation manifest；
  - POSIX rename + Windows ReplaceFileW 的 atomic replace、directory fsync 能力检测；
  - lease + owned generation GC。
  - buildState 顺序前进；非 complete owned build 标 abandoned 并 fresh generation 重扫。
- `src/lib/history/search/backfill.ts`
  - V3 commit_seq keyset scan；
  - fixed upper watermark + catch-up + final barrier；
  - cursor/progress persistence；
  - cooperative stop/drain；
  - active generation 保持服务。
- `src/lib/history/state.ts`
  - post-listen 低优先级 start；
  - shutdown stop + drain。
- v1 owned artifact 只在 V2 ready cutover 后清理。

### 测试

- fresh build from mixed format-v1/v2 operations；
- batch boundary/tied committed_at 不漏；
- buildState 非 complete 永不进 CURRENT；schema/projection/tokenizer/sourceStoreId mismatch 必须 fresh generation；
- live commits during build；
- crash at Tantivy commit、manifest fsync、CURRENT rename 前后；
- POSIX rename 与 Windows ReplaceFileW adapter；reader lease 存续时旧 generation 不 GC；
- N-API search Promise settle/Drop 才释放 generation lease；
- build fail 保持旧 generation；
- sidecar 删除后重建；
- wrong sourceStoreId/unknown directory 拒绝；
- building orphan 只清理 owned；
- queue drop 后 reconcile 归零；
- cursor/progress 重启续跑。

### Commit

```text
feat(history-search): rebuild Tantivy generations from V3
```

## Phase 6：Native query、filters、keyset 与 snippets

### 目标

实现完整但尚未公开的产品 query service。

### Native

- literal 2–256 scalar parser；
- content query + scope；
- Count collector + 50k matched-unit cap；超限返回 typed `query_too_broad`，不返回任意 TopDocs 子集；
- operation TermSetQuery + filters；
- `order_key` newest keyset；
- 最多 3 snippets/highlight ranges；
- 返回 generation/opstamp、partial reason、truncation。

### Backend

- `src/lib/history/search/service.ts`
  - native result → 批量 V3 summaries；
  - stale operation filter + delete queue；
  - status/readiness decision；
  - opaque cursor encode/decode + query fingerprint；
  - no-ready→typed unavailable；stale cursor→typed conflict。

### 测试

- scope/operationKind/model/endpoint/outcome/session/agent/pid/time 组合；
- newest tie + keyset；
- 相同 created_at + 乱序 operation IDs 的 order_key keyset；
- query/cursor generation mismatch；
- cursor 固定编码 generationId/queryFingerprint/orderKey，generation 切换返回 409；
- queryFingerprint 使用 canonical normalized request 的全宽 SHA-256；
- missing V3 summary stale hit；
- broad query 422；
- projection truncation；
- snippet Unicode offset/highlight/HTML payload escape；
- 100k synthetic query p95/p99。
- disabled→initializing→building→ready、ready 中 rebuild、degraded 自动恢复状态机；运行中删 active sidecar 只 degraded、不原地覆盖未知目录。

### Commit

```text
feat(history-search): query Tantivy by semantic scope
```

## Phase 7：HTTP/UI cutover

### 目标

一次性切换产品 contract，不能在 backend/UI 间留半版本。

### Backend

- `src/lib/history/types.ts`：operation-centric V2 types；
- `src/lib/history/search-types.ts`：scope/filter/cursor；
- `src/lib/history/search.ts`：async service；
- `src/routes/history/handler.ts`：typed 400/409/503；
- OpenAPI/API docs；
- `/search/contains` 标记 410；
- 旧 `source` 窄映射与 unsupported error。

### Vue UI

- source selector → scope selector；
- 删除 hash owner/contains 展开；
- operation summary + matched scopes + snippets；
- building/lagging/degraded/stale cursor 状态；
- 409 自动从第一页重试一次；
- snippet 纯文本高亮，不使用不可信 HTML。

### ui-v4

本 phase 只接已有全局搜索入口；不新增第三套 Search 页面。Requests 列表 preview filter 与全文搜索职责继续分离。

### 测试

- backend HTTP contract；
- Vue store/page；
- ui-v4 global search；
- OpenAPI schema；
- no-ready 不能显示“0 results”；
- accessibility/keyboard/loading/error states；
- E2E 从真实 V3 commit → Tantivy commit → HTTP → UI navigation。

### Commit

```text
feat(history): serve full-text search from Tantivy
```

## Phase 8：预编译发布矩阵与验收

### 构建

生成并测试：

- linux-x64-gnu；
- linux-arm64-gnu；
- darwin-x64；
- darwin-arm64；
- win32-x64-msvc。

loader 只能选择精确 platform/arch/libc binary。npm tarball smoke test 在无 Rust 环境运行 Bun 和 Node load/query。

### 最终门

- full backend/UI/E2E；
- Rust tests + clippy；
- secret scan；
- artifact corruption/failpoint suite；
- read-only real-corpus temporary-sidecar benchmark；
- 100k synthetic benchmark；
- independent adversarial review；
- 文档中只写实测数据，不把单次值写成普遍保证。

### Commit

```text
build(history-search): ship portable Tantivy binaries
```

## Rollback

Phase 1–6 不影响产品 API，可直接停用/删除 sidecar。Phase 7 如需 rollback：

- handler 回到明确 empty compatibility response；
- 不恢复任何 SQLite search table；
- Tantivy artifact 保留或删除均不影响 History；
- canonical V3 不需要 down migration。

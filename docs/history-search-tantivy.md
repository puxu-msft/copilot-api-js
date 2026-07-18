# History search Tantivy sidecar v1

> **状态：第一版已接入，产品查询尚未切换。** 本文描述 2026-07-18 从 History SQLite 移出的全文索引。权威语义数据仍是 `history-v3.db` 中的 `ModelOperationRecord`；Tantivy 目录可随时删除，不是 History 的组成部分。

## 1．边界

| Artifact | 默认位置 | 权威性 | 内容 |
|---|---|---|---|
| `history-v3.db` | `$XDG_DATA_HOME/copilot-api/history-v3.db` | 权威 | semantic CAS、manifest、tracks、timeline、journal、summary |
| `history-search/` | `$XDG_DATA_HOME/copilot-api/history-search/` | 可重建派生 | Tantivy segment、term dictionary、postings、stored operation ID/kind/time |
| `raw.db` | `$XDG_DATA_HOME/copilot-api/raw.db` | 可选诊断能力 | exact bytes |

History schema v5 会事务性删除旧的 `v3_search_objects`、`v3_search_membership`、`v3_search_backlog`。它不删除 `v3_operations`／`v3_objects`，也不打开或修改 legacy `history.db`。DROP 后的空闲 SQLite pages 是否立即归还文件系统由 SQLite incremental-vacuum 生命周期决定；逻辑搜索内容已不存在。

## 2．v1 索引格式

实现位于 `native/history-search/`，使用：

- Rust 2024；
- Tantivy 0.26；
- napi-rs 3；
- Tokio `spawn_blocking`，避免 Tantivy I/O/commit 在 JS event loop 内执行。

索引目录必须有精确 identity 文件：

```text
FORMAT = "copilot-api-history-search-tantivy-v1\n"
```

初始化只接受：

1. 空且尚未拥有的目录；或
2. identity 完全匹配的既有目录。

非空且无 identity、或 identity 不匹配的目录会 fail-loud，绝不把未知文件当索引覆盖。

Tantivy schema：

| Field | Type | Stored | 用途 |
|---|---|---:|---|
| `operation_id` | `STRING` | 是 | 稳定文档身份；upsert 前按 term 删除旧版本 |
| `operation_kind` | `STRING` | 是 | generation／responses_ws／count_tokens／embeddings 过滤 |
| `created_at` | `u64` | 是 | 后续稳定排序／投影 |
| `content` | `TEXT` | 否 | arena payload/frame semantic JSON 的全文倒排索引 |

`content` 不 stored，查询结果只返回 operation identity、time 与 BM25 score；详情必须回到 authoritative History facade 读取。

## 3．运行生命周期

磁盘 History 启动时：

1. `initHistory()` 打开并 reconcile `history-v3.db`；
2. 配置独立 Tantivy path；
3. terminal bus 向 V3 writer 和 Tantivy subscriber 分别发布同一 immutable canonical record；
4. Tantivy subscriber 串行 upsert，失败只把 `history_search.state` 标成 `degraded`；
5. shutdown 先停止接收新 terminal，再 drain V3 writer 与 Tantivy tail。

`:memory:` History 测试默认禁用 sidecar，避免把测试数据写到用户目录。注入的磁盘测试 DB 使用同路径的 `.tantivy` sibling。

`GET /api/status` 的 `history_search` 暴露：

- `enabled`；
- `state`: `disabled | initializing | ready | degraded`；
- `path`；
- `pendingOperations`；
- `indexedOperations`；
- `failedOperations`；
- `lastError`。

## 4．当前产品行为

本版本先完整退役旧能力：

- `GET /history/api/search` 固定返回 `{ rows: [], nextCursor: null, partial: false }`；
- `GET /history/api/search/contains?hash=...` 固定返回 `{ hash, reqIds: [] }`；
- 两个接口都不读 V2/V3 SQLite search table，也不查询 Tantivy；
- 老 Vue Search 页面因此显示空数据。

这是刻意的切换阶段，不做 SQLite fallback。native 层和 TypeScript manager 已提供直接 Tantivy query，供测试与下一版本 API cutover；在结果投影、分页、freshness/backfill 契约明确前不对产品暴露不完整结果。

## 5．已知限制

1. v1 每个 operation 一个 Tantivy document；尚未实现 object-level 去重 + membership postings。
2. 只实时索引新 terminal operation；没有从已有 V3 records 自动 backfill。
3. query parser 当前使用 Tantivy 默认 tokenizer/BM25，不等价于旧的 case-insensitive arbitrary substring。
4. JS 侧把 arena semantic values 序列化为 index input；Tantivy I/O 在 native blocking pool，但这次 JSON stringify 仍发生在 JS 线程。
5. 发布包目前携带构建主机平台的 `.node` binary；正式跨平台 release 还需 Linux/macOS/Windows prebuild matrix。

这些限制不会影响 canonical History 的写入和读取；sidecar 可删除后重新开始。

---
name: history-sqlite-schema
description: 当需要了解 copilot-api-js 的 History SQLite 数据库结构时使用——表/列/索引、entries_v2 head + entry_stages 拆表、content-addressed search_index(msg_blob/req_msg/req_aux)、history_meta 迁移账本、zstd blob 压缩、reaper 分桶、Umzug 迁移。也用于直接查库、写迁移、调试存储或解析 blob_gz。后台 backfill 的写法见 skill history-backfill。
---

# History SQLite Schema

## 权威真相源（优先用，别凭记忆）

- **DDL 单一源**：`src/lib/history/sqlite/schema.ts`（`SCHEMA_SQL` + `HISTORY_META_DDL`）。
- **驱动分流**：`src/lib/history/sqlite/driver.ts`（Bun `bun:sqlite` / Node `node:sqlite`，无 better-sqlite3）。
- **设计**：`docs/DESIGN.md`「核心模块·history」+ `docs/history.md`。
- **库文件**：`~/.local/share/copilot-api/history.db`（`PATHS.HISTORY_DB`，受 `XDG_DATA_HOME` / config `history.db_path` 影响；测试期 preload 重定向到临时目录）。

## 表

| 表 | 角色 |
|---|---|
| `entries_v2` | head 行（一请求一行），meta 列 + `blob_gz`（zstd 压缩生命周期）。`pinned=1` 豁免 reaper；`usage_normalized`（NOT NULL DEFAULT 0）= usage 净值化标记（新行生来 1，历史行由 usage-normalize-backfill 置 1，破坏性减法的幂等主闸） |
| `entry_stages` | per-stage/attempt 重 blob（inbound/effective/outbound req+resp、sse_events），FK CASCADE |
| `response_sessions` | response_id → session_id |
| `msg_blob` | content-addressed：每条归一化消息存一次（hash PK），跨请求去重 |
| `req_msg` | 请求→消息位置（FK CASCADE）；孤儿 msg_blob 由 reaper GC |
| `req_aux` | per-request 4 facet 搜索文本（rewrites/headers） |
| `history_meta` | KV：`search_index_version` 迁移守卫 + backfill 游标 + `usage_normalize_version`/`_cursor` + Umzug `schema_migrations` 账本 |

## 直接查库

```bash
sqlite3 ~/.local/share/copilot-api/history.db ".tables"
sqlite3 ~/.local/share/copilot-api/history.db ".schema entries_v2"
# 最近失败（status: failed/aborted/interrupted；成功=completed）
sqlite3 history.db "SELECT id,model,status,error_message FROM entries_v2 WHERE status IN ('failed','aborted','interrupted') ORDER BY started_at DESC LIMIT 10"
# 某会话
sqlite3 history.db "SELECT id,status FROM entries_v2 WHERE session_id=? ORDER BY started_at"
```

`blob_gz` 是 zstd（magic `28b52ffd`，旧库 gzip `1f8b`）：解压用 `compression.ts` 的 `decompress`。entry_stages.stage ∈ inbound_request/effective_request/outbound_request/outbound_response/inbound_response/sse_events（finalized 后前三者合并进 request_group 容器帧）。**勿对运行中库直读**——live churn 致 torn snapshot，用 `/history/api/entries/:id`（六腿全量 `assembleFullEntry`）。

## reaper / 双源

reaper 按 status 分桶（success/failure 各上限），active+pinned 行豁免、不计名额。读取 in-flight 优先（`getInFlight ?? getEntryById`），active 请求恒读内存全量。详见 docs/history.md。

## 迁移

001+ 前向 DDL 进 `migrations/`，须幂等（`PRAGMA table_info` 探测）；openDatabase 的 inline reconcile 是 000 地板不进账本。bun:sqlite `db.transaction` 回调必须同步（跨 await 不回滚）。

写/改后台 backfill（建索引、重算派生列、破坏性变换已存字段）见 skill `history-backfill`。


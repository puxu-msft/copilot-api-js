> **📦 已归档（History V2 removal，2026-07-18）** —— 本文档描述的 History V2 存储机制（`entries_v2`/`entry_stages`/SQLite gzip 单表持久化）随 V2 整体移除已不再是活代码，仅作历史设计记录保留。当前 History V3 架构见 [DESIGN.md](../../DESIGN.md)「活的架构现状」`src/lib/history/` 行 + skill `history-sqlite-schema`。

# SQLite History 持久化设计

**Date:** 2026-04-17
**Status:** Approved
**Scope:** 用基于 SQLite + gzip 压缩的磁盘持久化存储**完全替换**现有内存 History；同时将所有应用文件路径统一到 `XDG_DATA_HOME` 可覆盖的单一目录。

## 背景与目标

当前 History 系统仅存在于内存中，重启服务后全部丢失；`MemoryPressureManager` 基于堆占用做 LRU 淘汰，逻辑复杂且条目可见性不稳定。需要：

1. **持久化所有已完成请求**到磁盘，重启后可见。
2. **可预测的容量管理**：基于行数而非堆占用。
3. **REST / WebSocket API 对前端完全透明**：前端代码无需修改。
4. **路径统一**：所有应用文件（配置、令牌、数据库等）遵循同一路径策略。

## 非目标

- 进行中请求的持久化：保持在 `RequestContext` 中，仅通过 WebSocket 实时推送，不落盘。
- 跨进程并发访问：仅单进程写入。
- 历史数据迁移：当前 History 为内存数据，无需迁移;文件路径也默认保持不变（未显式设置 `XDG_DATA_HOME` 时）。

## 架构决策

| 维度 | 决策 | 理由 |
|------|------|------|
| 存储引擎 | `bun:sqlite`（Bun 内置） | 零新增依赖；项目运行时即为 Bun |
| 压缩实现 | `Bun.gzipSync` / `Bun.gunzipSync` | 零依赖；对 JSON payload 压缩率与速度良好 |
| 压缩粒度 | **单 blob 合并压缩**：将所有"重字段"序列化为单个 JSON 后整体 gzip | 相同数据 gzip 字典复用，压缩率高于分字段压缩 |
| 写入时机 | 请求**完成 / 失败**时一次性写入 | 避免进行中反复写入 |
| 内存缓存 | 无 | 查询直接走 SQLite，指标可预测；`MemoryPressureManager` 随之删除 |
| WebSocket 语义 | `entry_added`（开始，快照源=RequestContext）/ `entry_updated`（流过程，源=RequestContext）/ 最终 `entry_updated`（完成，源=SQLite 回读） | 前端行为完全不变 |
| 容量管理 | 定期 reaper（默认 10 min）检查行数，超过 `history.limit`（默认 10000）删除最旧 | 简单、可预测 |
| 默认启用 | 是，作为唯一 history 实现 | 用户确认 |
| 数据库位置 | `$XDG_DATA_HOME/copilot-api/history.db` → fallback `~/.local/share/copilot-api/history.db` | 与其他应用文件同目录 |
| API 兼容性 | REST / WebSocket 端点签名与语义不变 | 前端透明 |

## 表结构

```sql
CREATE TABLE IF NOT EXISTS entries (
  id               TEXT PRIMARY KEY,
  session_id       TEXT,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  duration_ms      INTEGER,
  model            TEXT,
  endpoint         TEXT,
  transport        TEXT,
  status           TEXT NOT NULL,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  cache_read       INTEGER,
  cache_creation   INTEGER,
  reasoning_tokens INTEGER,
  stop_reason      TEXT,
  error_message    TEXT,
  blob_gz          BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_started_at ON entries(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_session    ON entries(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_model      ON entries(model, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_status     ON entries(status, started_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  start_time           INTEGER NOT NULL,
  last_activity        INTEGER NOT NULL,
  request_count        INTEGER NOT NULL DEFAULT 0,
  total_input_tokens   INTEGER NOT NULL DEFAULT 0,
  total_output_tokens  INTEGER NOT NULL DEFAULT 0,
  models_json          TEXT,
  endpoints_json       TEXT,
  tools_used_json      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity DESC);
```

### 列拆分策略

- **元数据列**（独立列）：用于 SQL 过滤和排序，对应 `QueryOptions` 支持的所有字段。
- **blob_gz**（合并压缩）：`gzip(JSON.stringify({ request, response, timeline, pipeline, sanitization, truncation, warnings, preview, system, tools, sseEvents, ... }))`。所有"重字段"以原样 JSON 嵌套写入该 blob。

查询 summary 时不解压 blob（显著提速 list 查询）；查询完整 entry 时 `gunzipSync` + `JSON.parse` 恢复。

## 路径策略

扩展 `src/lib/config/paths.ts`：

```typescript
const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
const APP_DIR = path.join(dataHome, "copilot-api")

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH:    path.join(APP_DIR, "github_token"),
  CONFIG_YAML:          path.join(APP_DIR, "config.yaml"),
  LEARNED_LIMITS:       path.join(APP_DIR, "learned-limits.json"),
  REQUEST_TELEMETRY:    path.join(APP_DIR, "request-telemetry.json"),
  ERROR_DIR:            path.join(APP_DIR, "errmsgs"),
  HISTORY_DB:           path.join(APP_DIR, "history.db"),
}
```

**向后兼容性**：未设置 `XDG_DATA_HOME` 时 `APP_DIR` 仍为 `~/.local/share/copilot-api/`，与现行为一致。设置了该变量则所有文件统一到新位置，用户无需迁移旧文件。

## 模块变更

```
src/lib/history/
├── sqlite/                     新增
│   ├── connection.ts           打开/初始化 db、pragma（WAL、synchronous=NORMAL）、schema 初始化
│   ├── schema.sql              建表语句
│   ├── compression.ts          gzipSync / gunzipSync 封装 + 异常处理
│   ├── serialize.ts            HistoryEntry ↔ { row, blob } 双向转换
│   ├── write.ts                insertEntry / upsertSession / deleteSession
│   ├── read.ts                 queryEntries / querySummaries / getEntry / getSessions
│   ├── stats.ts                SQL 聚合实现 getStats / exportHistory
│   └── reaper.ts               setInterval 定期清理超出 limit 的旧行
├── state.ts                    移除内存数组；保留 initHistory()（初始化 connection + 启动 reaper）
├── entries.ts                  insertEntry / updateEntry 改为调 sqlite/write
├── queries.ts                  改为调 sqlite/read
├── sessions.ts                 改为调 sqlite/read + sqlite/write
├── stats.ts                    改为调 sqlite/stats
├── memory-pressure.ts          删除
└── types.ts                    不变（复用现有类型作为 blob JSON 的 schema）
```

## 数据流

### 请求生命周期

```
request in
  → RequestContext created
  → WebSocket emit "entry_added"  (source: RequestContext snapshot)
  → ... streaming / pipeline / sanitization ...
  → WebSocket emit "entry_updated" (source: RequestContext snapshot)  [可多次]
  → request completes or fails
  → consumers.persist()
     → build HistoryEntry snapshot from RequestContext
     → serialize: (meta cols, blob JSON) → gzip blob
     → transaction:
         INSERT INTO entries (...) VALUES (...)
         UPSERT sessions     (...)
     → WebSocket emit "entry_updated" final (source: sqlite read)
  → RequestContext released
```

### 容量清理（reaper）

```
every history.reaper_interval seconds:
  IF history.limit > 0:
    SELECT COUNT(*) FROM entries
    IF count > limit:
      DELETE FROM entries WHERE id IN (
        SELECT id FROM entries ORDER BY started_at ASC LIMIT count - limit
      )
      emit "history_evicted" via WebSocket (optional)
```

## 配置

`config.yaml` 下的 `history` 段：

```yaml
history:
  limit: 10000            # SQLite 行数上限；0 = 无限制
  reaper_interval: 600    # 定期清理秒数；0 = 禁用自动清理
  # db_path: <override>   可选，默认由 PATHS.HISTORY_DB 决定
```

对应 `state.ts` 中：

- 保留：`historyLimit`
- 新增：`historyReaperInterval`、`historyDbPath`（可选覆盖）
- 移除:`historyMinEntries`、`MemoryPressureManager` 相关状态

## REST / WebSocket 兼容性

### REST 端点（签名与响应 schema 不变）

- `GET /history/api/entries` — SQL 过滤 meta 列；响应中每个 entry 的"重字段"通过解压 blob 填充。
- `GET /history/api/entries/:id` — 按 id 查询 + 解压。
- `GET /history/api/sessions`、`GET /history/api/sessions/:id`、`GET /history/api/sessions/:id/entries`、`DELETE /history/api/sessions/:id` — 均改走 SQL。
- `GET /history/api/stats`、`GET /history/api/export` — SQL 聚合 / 按 cursor 流式解压。

### WebSocket

- `entry_added` / `entry_updated` / `stats_updated` / `history_cleared` / `session_deleted` 语义不变。
- 进行中快照来源仍是 `RequestContext`；完成态从 SQLite 回读。

## 错误处理与可靠性

- **db 打开失败**（权限、磁盘、损坏）：`initHistory()` 记录 error-level 日志并抛出；服务启动失败（与当前 `ensurePaths` 行为一致性）。
- **写入失败**：在 `consumers.persist()` 捕获，log warn，丢弃该条（不阻塞请求响应链）；WebSocket 仍推送来自 RequestContext 的快照。
- **解压失败**：记录 warn + entry id，返回一个带 `error_message="corrupt blob"` 的占位 entry，避免整个列表接口失败。
- **事务**：`insertEntry` + `upsertSession` 包在单个事务中，保证两者一致。
- **WAL + synchronous=NORMAL**：在 `connection.ts` 中开启，平衡吞吐与安全。

## 测试计划

### 单元测试（`tests/history/sqlite/*.test.ts`）

- `compression.test.ts` — gzip/gunzip 往返；非字符串/空串边界。
- `serialize.test.ts` — HistoryEntry ↔ row+blob 等价性；所有类型变体（thinking、tool_use、image、server_tool_result）。
- `write.test.ts` — insert / upsert / 事务回滚。
- `read.test.ts` — `QueryOptions` 全组合（model、endpoint、from/to、status、limit/offset）。
- `reaper.test.ts` — 刚好等于 limit / 超出 / limit=0 / interval=0 各边界。

### 集成测试（`tests/history/integration.test.ts`）

- 一次完整请求 → 完成 → 从 REST 端点查询到 entry → 字段完整。
- 多请求并发 → session 聚合字段正确。
- reaper 在跑满 limit 后清理，旧 entry 不可查，新 entry 正常。

### 兼容性测试

- 前端 UI 手动冒烟（entries 列表、详情、sessions、stats、export）。
- `XDG_DATA_HOME` 未设置 vs 设置的路径解析（`src/lib/config/paths.test.ts`）。

### 性能基准（非阻塞）

- 1 万条 entries 下 `GET /history/api/entries?limit=100` summary 查询（不解压 blob）应在 50 ms 级。
- 单 entry 解压 + 返回应在 10 ms 级（典型 payload < 100 KB）。

## 开源与许可

本次改动完全在项目内部实现，无新增第三方依赖。

## 待跟进 / Out of Scope

- 全文搜索（FTS5）— 用户原始提问未要求；留作将来扩展。
- 跨进程锁定 / 多进程写入 — 当前服务为单进程。
- 历史数据从旧版本 export/import 工具 — 不存在旧版本。

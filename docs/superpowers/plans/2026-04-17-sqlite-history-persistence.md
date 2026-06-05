# SQLite History Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用基于 SQLite + gzip 的磁盘持久化完全替换内存 History，并让所有应用文件路径尊重 `XDG_DATA_HOME`。

**Architecture:** 新增 `src/lib/history/sqlite/` 子模块封装所有 SQLite 读写；仅在请求完成/失败时写入一次；内存淘汰机制（`MemoryPressureManager`）与 `historyMinEntries` 彻底移除；定期 reaper 按行数上限清理。REST/WebSocket 端点签名、前端代码不变。

**Tech Stack:** Bun (`bun:sqlite`, `Bun.gzipSync`), TypeScript strict, Bun test runner, Hono.

**Design Doc:** [docs/superpowers/specs/2026-04-17-sqlite-history-persistence-design.md](../specs/2026-04-17-sqlite-history-persistence-design.md)

---

## 文件结构

### 新建

- `src/lib/history/sqlite/connection.ts` — 单例 DB 连接 + pragma + schema 初始化
- `src/lib/history/sqlite/schema.ts` — DDL 常量字符串（TypeScript 模块而非 `.sql` 以避免额外 loader）
- `src/lib/history/sqlite/compression.ts` — `gzipJson` / `gunzipJson` 封装
- `src/lib/history/sqlite/serialize.ts` — HistoryEntry ↔ { row, blob } 双向转换
- `src/lib/history/sqlite/write.ts` — 完成态写入（含事务）、session upsert、删除
- `src/lib/history/sqlite/read.ts` — entry/summary/session 的 SQL 查询实现
- `src/lib/history/sqlite/stats.ts` — getStats / exportHistory 的 SQL 聚合实现
- `src/lib/history/sqlite/reaper.ts` — 定期清理超出 limit 的旧 entry
- `src/lib/history/in-flight.ts` — 进行中 entry 的内存映射（仅用于 WebSocket 快照，不持久化，不对外导出）
- `tests/unit/history/sqlite/compression.test.ts`
- `tests/unit/history/sqlite/serialize.test.ts`
- `tests/unit/history/sqlite/write-read.test.ts`
- `tests/unit/history/sqlite/reaper.test.ts`
- `tests/unit/config/paths.test.ts`
- `tests/integration/history/persistence.test.ts`

### 修改

- `src/lib/config/paths.ts` — `APP_DIR` 尊重 `XDG_DATA_HOME`；新增 `HISTORY_DB`
- `src/lib/state.ts` — 移除 `historyMinEntries`，新增 `historyReaperInterval`、`historyDbPath`
- `src/lib/config/config.ts` — yaml `history.reaper_interval`、废弃 `history.min_entries`（忽略并 warn）
- `src/lib/history/entries.ts` — `insertEntry` / `updateEntry` / `clearHistory` 委托 in-flight + sqlite
- `src/lib/history/queries.ts` — 转为查询 in-flight + sqlite
- `src/lib/history/sessions.ts` — 转为 sqlite
- `src/lib/history/stats.ts` — 转为 sqlite
- `src/lib/history/state.ts` — 删除内存 `entries[]` / `historyIndexes`；`initHistory` 打开 DB + 启动 reaper
- `src/lib/history/index.ts` — 移除 memory-pressure 导出
- `src/lib/history/store.ts` — 同步 re-export 调整
- `src/lib/shutdown.ts` — 停 reaper、关闭 DB，替代 stopMemoryPressureMonitor
- `src/start.ts` — 去除 startMemoryPressureMonitor
- `src/routes/status/route.ts` — 去除 getMemoryPressureStats
- `src/routes/config/route.ts` — 响应中去除 historyMinEntries
- `docs/history.md`、`docs/DESIGN.md` — 文档同步

### 删除

- `src/lib/history/memory-pressure.ts`

---

## Task 1: 路径策略 — 尊重 XDG_DATA_HOME

**Files:**
- Modify: `src/lib/config/paths.ts`
- Test: `tests/unit/config/paths.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/unit/config/paths.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"

describe("config/paths", () => {
  const ORIG_ENV = process.env.XDG_DATA_HOME

  beforeEach(() => {
    delete process.env.XDG_DATA_HOME
  })

  afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = ORIG_ENV
  })

  test("falls back to ~/.local/share when XDG_DATA_HOME is unset", async () => {
    delete require.cache[require.resolve("~/lib/config/paths")]
    const mod = await import("~/lib/config/paths?fresh=unset")
    expect(mod.PATHS.APP_DIR).toBe(path.join(os.homedir(), ".local", "share", "copilot-api"))
    expect(mod.PATHS.HISTORY_DB).toBe(path.join(mod.PATHS.APP_DIR, "history.db"))
  })

  test("respects XDG_DATA_HOME when set", async () => {
    process.env.XDG_DATA_HOME = "/tmp/xdg-test"
    const mod = await import("~/lib/config/paths?fresh=set")
    expect(mod.PATHS.APP_DIR).toBe("/tmp/xdg-test/copilot-api")
    expect(mod.PATHS.CONFIG_YAML).toBe("/tmp/xdg-test/copilot-api/config.yaml")
    expect(mod.PATHS.HISTORY_DB).toBe("/tmp/xdg-test/copilot-api/history.db")
  })
})
```

Note: `paths.ts` currently evaluates `APP_DIR` at module load, so the test uses cache-busting query strings `?fresh=…` so each import re-executes. If Bun's import resolver doesn't differentiate query strings, refactor `PATHS` into a getter or the test switches to child-process-style verification via `spawnSync`. **Use `spawnSync` with a small inline script if cache-busting fails.**

- [ ] **Step 2: Run test — expect FAIL**

```bash
bun test tests/unit/config/paths.test.ts
```
Expected: FAIL (`HISTORY_DB` does not exist, APP_DIR does not honor XDG_DATA_HOME).

- [ ] **Step 3: Modify `src/lib/config/paths.ts`**

Replace the module body:

```typescript
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

function computeAppDir(): string {
  const override = process.env.XDG_DATA_HOME
  const base = override && override.length > 0 ? override : path.join(os.homedir(), ".local", "share")
  return path.join(base, "copilot-api")
}

const APP_DIR = computeAppDir()

const GITHUB_TOKEN_PATH = path.join(APP_DIR, "github_token")

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  CONFIG_YAML: path.join(APP_DIR, "config.yaml"),
  LEARNED_LIMITS: path.join(APP_DIR, "learned-limits.json"),
  REQUEST_TELEMETRY: path.join(APP_DIR, "request-telemetry.json"),
  ERROR_DIR: path.join(APP_DIR, "errmsgs"),
  HISTORY_DB: path.join(APP_DIR, "history.db"),
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
}

async function ensureFile(filePath: string): Promise<void> {
  const isWindows = process.platform === "win32"
  try {
    await fs.access(filePath, fs.constants.W_OK)
    if (!isWindows) {
      const stats = await fs.stat(filePath)
      const currentMode = stats.mode & 0o777
      if (currentMode !== 0o600) {
        await fs.chmod(filePath, 0o600)
      }
    }
  } catch {
    await fs.writeFile(filePath, "")
    if (!isWindows) {
      await fs.chmod(filePath, 0o600)
    }
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
bun test tests/unit/config/paths.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config/paths.ts tests/unit/config/paths.test.ts
git commit -m "feat(paths): honor XDG_DATA_HOME and add HISTORY_DB path"
```

---

## Task 2: 压缩工具 `sqlite/compression.ts`

**Files:**
- Create: `src/lib/history/sqlite/compression.ts`
- Test: `tests/unit/history/sqlite/compression.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test"

import { gunzipJson, gzipJson } from "~/lib/history/sqlite/compression"

describe("sqlite/compression", () => {
  test("roundtrips arbitrary JSON", () => {
    const obj = {
      messages: [{ role: "user", content: "hello 压缩" }],
      meta: { a: 1, b: null, c: [true, false] },
    }
    const blob = gzipJson(obj)
    expect(blob).toBeInstanceOf(Uint8Array)
    expect(blob.length).toBeGreaterThan(0)
    expect(gunzipJson(blob)).toEqual(obj)
  })

  test("gzipJson produces smaller output for repetitive payloads", () => {
    const big = { text: "abc".repeat(2000) }
    const blob = gzipJson(big)
    expect(blob.length).toBeLessThan(JSON.stringify(big).length / 4)
  })

  test("gunzipJson throws on malformed blob", () => {
    expect(() => gunzipJson(new Uint8Array([0, 1, 2, 3, 4]))).toThrow()
  })
})
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
bun test tests/unit/history/sqlite/compression.test.ts
```
Expected: FAIL (module missing).

- [ ] **Step 3: Create `src/lib/history/sqlite/compression.ts`**

```typescript
/** JSON + gzip helpers for history blob storage. */

export function gzipJson(value: unknown): Uint8Array {
  const json = JSON.stringify(value)
  return Bun.gzipSync(json)
}

export function gunzipJson<T = unknown>(blob: Uint8Array): T {
  const bytes = Bun.gunzipSync(blob)
  const text = new TextDecoder().decode(bytes)
  return JSON.parse(text) as T
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
bun test tests/unit/history/sqlite/compression.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/history/sqlite/compression.ts tests/unit/history/sqlite/compression.test.ts
git commit -m "feat(history/sqlite): add gzip json helpers"
```

---

## Task 3: Schema + Connection

**Files:**
- Create: `src/lib/history/sqlite/schema.ts`
- Create: `src/lib/history/sqlite/connection.ts`
- Test: add schema init coverage in Task 4's read/write test.

- [ ] **Step 1: Create `src/lib/history/sqlite/schema.ts`**

```typescript
export const SCHEMA_SQL = `
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

CREATE TABLE IF NOT EXISTS response_sessions (
  response_id TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL
);
`
```

- [ ] **Step 2: Create `src/lib/history/sqlite/connection.ts`**

```typescript
import fs from "node:fs"
import path from "node:path"
import { Database } from "bun:sqlite"

import consola from "consola"

import { SCHEMA_SQL } from "./schema"

let db: Database | null = null
let openedPath: string | null = null

export function openDatabase(dbPath: string): Database {
  if (db && openedPath === dbPath) return db
  if (db) closeDatabase()

  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  db = new Database(dbPath)
  openedPath = dbPath
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA synchronous = NORMAL;")
  db.exec("PRAGMA foreign_keys = ON;")
  db.exec(SCHEMA_SQL)
  consola.info(`[history/sqlite] opened ${dbPath}`)
  return db
}

export function getDatabase(): Database {
  if (!db) throw new Error("[history/sqlite] database not initialized; call openDatabase first")
  return db
}

export function closeDatabase(): void {
  if (!db) return
  try {
    db.close()
  } catch (err: unknown) {
    consola.warn("[history/sqlite] error closing db", err)
  }
  db = null
  openedPath = null
}

/** For tests: open an in-memory db. */
export function openInMemoryDatabase(): Database {
  return openDatabase(":memory:")
}
```

- [ ] **Step 3: Smoke check — import works**

```bash
bun run typecheck
```
Expected: typecheck passes.

- [ ] **Step 4: Commit**

```bash
git add src/lib/history/sqlite/schema.ts src/lib/history/sqlite/connection.ts
git commit -m "feat(history/sqlite): add schema and connection layer"
```

---

## Task 4: Serialize — HistoryEntry ↔ row+blob

**Files:**
- Create: `src/lib/history/sqlite/serialize.ts`
- Test: `tests/unit/history/sqlite/serialize.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import { deserializeEntry, serializeEntry, type EntryRow } from "~/lib/history/sqlite/serialize"

const sample: HistoryEntry = {
  id: "abc-123",
  sessionId: "sess-1",
  endpoint: "anthropic-messages",
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_001_000,
  durationMs: 1000,
  state: "completed",
  active: false,
  lastUpdatedAt: 1_700_000_001_000,
  transport: "http",
  request: {
    model: "claude-opus-4-7",
    messages: [{ role: "user", content: "hi" }],
  },
  response: {
    success: true,
    model: "claude-opus-4-7",
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: "end_turn",
    content: { role: "assistant", content: "hello" },
  },
}

describe("sqlite/serialize", () => {
  test("round-trips a HistoryEntry losslessly", () => {
    const { row, blob } = serializeEntry(sample)
    expect(row.id).toBe("abc-123")
    expect(row.session_id).toBe("sess-1")
    expect(row.started_at).toBe(1_700_000_000_000)
    expect(row.status).toBe("completed")
    expect(row.model).toBe("claude-opus-4-7")
    expect(row.input_tokens).toBe(10)
    expect(row.output_tokens).toBe(5)
    expect(blob).toBeInstanceOf(Uint8Array)

    const restored = deserializeEntry(row, blob)
    expect(restored).toEqual(sample)
  })

  test("handles missing optional fields", () => {
    const minimal: HistoryEntry = {
      id: "x",
      endpoint: "openai-chat-completions",
      startedAt: 1,
      state: "failed",
      active: false,
      lastUpdatedAt: 1,
      request: { model: "m" },
    } as HistoryEntry

    const { row, blob } = serializeEntry(minimal)
    expect(row.session_id).toBeNull()
    expect(row.ended_at).toBeNull()
    expect(row.input_tokens).toBeNull()

    const restored = deserializeEntry(row, blob)
    expect(restored.id).toBe("x")
    expect(restored.request.model).toBe("m")
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test tests/unit/history/sqlite/serialize.test.ts
```
Expected: FAIL (module missing).

- [ ] **Step 3: Create `src/lib/history/sqlite/serialize.ts`**

```typescript
import type { HistoryEntry } from "~/lib/history/types"

import { gunzipJson, gzipJson } from "./compression"

export interface EntryRow {
  id: string
  session_id: string | null
  started_at: number
  ended_at: number | null
  duration_ms: number | null
  model: string | null
  endpoint: string | null
  transport: string | null
  status: string
  input_tokens: number | null
  output_tokens: number | null
  cache_read: number | null
  cache_creation: number | null
  reasoning_tokens: number | null
  stop_reason: string | null
  error_message: string | null
  blob_gz: Uint8Array
}

/** Keys kept in the meta columns; everything else goes into blob_gz. */
const META_KEYS = new Set<keyof HistoryEntry>([
  "id",
  "sessionId",
  "startedAt",
  "endedAt",
  "durationMs",
  "endpoint",
  "transport",
  "state",
])

export function serializeEntry(entry: HistoryEntry): { row: EntryRow; blob: Uint8Array } {
  const usage = entry.response?.usage
  const blob = gzipJson(extractBlobPayload(entry))

  const row: EntryRow = {
    id: entry.id,
    session_id: entry.sessionId ?? null,
    started_at: entry.startedAt ?? 0,
    ended_at: entry.endedAt ?? null,
    duration_ms: entry.durationMs ?? null,
    model: entry.response?.model ?? entry.request?.model ?? null,
    endpoint: entry.endpoint ?? null,
    transport: entry.transport ?? null,
    status: entry.state ?? "unknown",
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    cache_read: usage?.cache_read_input_tokens ?? null,
    cache_creation: usage?.cache_creation_input_tokens ?? null,
    reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
    stop_reason: entry.response?.stop_reason ?? null,
    error_message: entry.response?.error ?? null,
    blob_gz: blob,
  }
  return { row, blob }
}

export function deserializeEntry(row: EntryRow, blob?: Uint8Array): HistoryEntry {
  const bytes = blob ?? row.blob_gz
  const restored = gunzipJson<Partial<HistoryEntry>>(bytes)
  return {
    ...restored,
    id: row.id,
    sessionId: row.session_id ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    endpoint: (row.endpoint ?? restored.endpoint) as HistoryEntry["endpoint"],
    transport: (row.transport ?? restored.transport) as HistoryEntry["transport"],
    state: (row.status as HistoryEntry["state"]) ?? restored.state,
    active: false,
    lastUpdatedAt: row.ended_at ?? row.started_at,
  } as HistoryEntry
}

function extractBlobPayload(entry: HistoryEntry): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (META_KEYS.has(key as keyof HistoryEntry)) continue
    payload[key] = value
  }
  return payload
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
bun test tests/unit/history/sqlite/serialize.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/history/sqlite/serialize.ts tests/unit/history/sqlite/serialize.test.ts
git commit -m "feat(history/sqlite): serialize HistoryEntry to row+blob"
```

---

## Task 5: Write + Read + Stats

**Files:**
- Create: `src/lib/history/sqlite/write.ts`
- Create: `src/lib/history/sqlite/read.ts`
- Create: `src/lib/history/sqlite/stats.ts`
- Test: `tests/unit/history/sqlite/write-read.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { beforeEach, describe, expect, test } from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import { closeDatabase, openInMemoryDatabase } from "~/lib/history/sqlite/connection"
import { queryEntries, getEntryById, queryEntryCount } from "~/lib/history/sqlite/read"
import { insertCompletedEntry, clearAllEntries } from "~/lib/history/sqlite/write"

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    endpoint: "anthropic-messages",
    startedAt: Date.now(),
    endedAt: Date.now() + 100,
    durationMs: 100,
    state: "completed",
    active: false,
    lastUpdatedAt: Date.now() + 100,
    transport: "http",
    request: { model: "claude-opus-4-7" },
    response: {
      success: true,
      model: "claude-opus-4-7",
      usage: { input_tokens: 1, output_tokens: 2 },
      content: { role: "assistant", content: "ok" },
    },
    ...overrides,
  } as HistoryEntry
}

describe("sqlite write/read", () => {
  beforeEach(() => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("insert and query by id", () => {
    const entry = makeEntry({ id: "e1", sessionId: "s1" })
    insertCompletedEntry(entry)
    const got = getEntryById("e1")
    expect(got?.id).toBe("e1")
    expect(got?.response?.usage.input_tokens).toBe(1)
  })

  test("queryEntries filters by model", () => {
    insertCompletedEntry(makeEntry({ id: "a", request: { model: "m1" }, response: { success: true, model: "m1", usage: { input_tokens: 1, output_tokens: 1 }, content: null } }))
    insertCompletedEntry(makeEntry({ id: "b", request: { model: "m2" }, response: { success: true, model: "m2", usage: { input_tokens: 1, output_tokens: 1 }, content: null } }))
    const byM1 = queryEntries({ model: "m1", limit: 10 })
    expect(byM1.map((e) => e.id)).toEqual(["a"])
  })

  test("clearAllEntries empties both tables", () => {
    insertCompletedEntry(makeEntry({ id: "z" }))
    expect(queryEntryCount()).toBe(1)
    clearAllEntries()
    expect(queryEntryCount()).toBe(0)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test tests/unit/history/sqlite/write-read.test.ts
```

- [ ] **Step 3: Create `src/lib/history/sqlite/write.ts`**

```typescript
import type { HistoryEntry, Session } from "~/lib/history/types"

import { getDatabase } from "./connection"
import { serializeEntry } from "./serialize"

const INSERT_ENTRY_SQL = `
INSERT OR REPLACE INTO entries (
  id, session_id, started_at, ended_at, duration_ms,
  model, endpoint, transport, status,
  input_tokens, output_tokens, cache_read, cache_creation, reasoning_tokens,
  stop_reason, error_message, blob_gz
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`

const UPSERT_SESSION_SQL = `
INSERT INTO sessions (id, start_time, last_activity, request_count, total_input_tokens, total_output_tokens, models_json, endpoints_json, tools_used_json)
VALUES (?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  last_activity = excluded.last_activity,
  request_count = request_count + 1,
  total_input_tokens = total_input_tokens + excluded.total_input_tokens,
  total_output_tokens = total_output_tokens + excluded.total_output_tokens,
  models_json = excluded.models_json,
  endpoints_json = excluded.endpoints_json,
  tools_used_json = excluded.tools_used_json
`

export function insertCompletedEntry(entry: HistoryEntry): void {
  const db = getDatabase()
  const { row } = serializeEntry(entry)

  db.transaction(() => {
    db.prepare(INSERT_ENTRY_SQL).run(
      row.id,
      row.session_id,
      row.started_at,
      row.ended_at,
      row.duration_ms,
      row.model,
      row.endpoint,
      row.transport,
      row.status,
      row.input_tokens,
      row.output_tokens,
      row.cache_read,
      row.cache_creation,
      row.reasoning_tokens,
      row.stop_reason,
      row.error_message,
      row.blob_gz,
    )

    if (row.session_id) {
      db.prepare(UPSERT_SESSION_SQL).run(
        row.session_id,
        row.started_at,
        row.ended_at ?? row.started_at,
        1,
        row.input_tokens ?? 0,
        row.output_tokens ?? 0,
        JSON.stringify(row.model ? [row.model] : []),
        JSON.stringify(row.endpoint ? [row.endpoint] : []),
        null,
      )
    }
  })()
}

export function deleteSession(sessionId: string): number {
  const db = getDatabase()
  let deleted = 0
  db.transaction(() => {
    const r = db.prepare("DELETE FROM entries WHERE session_id = ?").run(sessionId)
    deleted = Number(r.changes ?? 0)
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId)
  })()
  return deleted
}

export function clearAllEntries(): void {
  const db = getDatabase()
  db.transaction(() => {
    db.prepare("DELETE FROM entries").run()
    db.prepare("DELETE FROM sessions").run()
    db.prepare("DELETE FROM response_sessions").run()
  })()
}

export function upsertResponseSession(responseId: string, sessionId: string): void {
  getDatabase()
    .prepare("INSERT OR REPLACE INTO response_sessions (response_id, session_id) VALUES (?, ?)")
    .run(responseId, sessionId)
}

export function upsertSessionMeta(session: Session): void {
  getDatabase()
    .prepare(`
      INSERT INTO sessions (id, start_time, last_activity, request_count, total_input_tokens, total_output_tokens, models_json, endpoints_json, tools_used_json)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        last_activity = excluded.last_activity,
        request_count = excluded.request_count,
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        models_json = excluded.models_json,
        endpoints_json = excluded.endpoints_json,
        tools_used_json = excluded.tools_used_json
    `)
    .run(
      session.id,
      session.startTime,
      session.lastActivity,
      session.requestCount,
      session.totalInputTokens,
      session.totalOutputTokens,
      JSON.stringify(session.models ?? []),
      JSON.stringify(session.endpoints ?? []),
      session.toolsUsed ? JSON.stringify(session.toolsUsed) : null,
    )
}
```

- [ ] **Step 4: Create `src/lib/history/sqlite/read.ts`**

```typescript
import type { EntrySummary, HistoryEntry, QueryOptions, Session } from "~/lib/history/types"

import { getDatabase } from "./connection"
import { deserializeEntry, type EntryRow } from "./serialize"

function applyWhere(opts: QueryOptions | undefined): { sql: string; params: Array<unknown> } {
  const where: Array<string> = []
  const params: Array<unknown> = []
  if (opts?.model) {
    where.push("model = ?")
    params.push(opts.model)
  }
  if (opts?.endpoint) {
    where.push("endpoint = ?")
    params.push(opts.endpoint)
  }
  if (opts?.sessionId) {
    where.push("session_id = ?")
    params.push(opts.sessionId)
  }
  if (opts?.from !== undefined) {
    where.push("started_at >= ?")
    params.push(opts.from)
  }
  if (opts?.to !== undefined) {
    where.push("started_at <= ?")
    params.push(opts.to)
  }
  const sql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
  return { sql, params }
}

export function queryEntries(opts?: QueryOptions): Array<HistoryEntry> {
  const db = getDatabase()
  const { sql, params } = applyWhere(opts)
  const limit = opts?.limit ?? 100
  const offset = opts?.offset ?? 0
  const rows = db
    .prepare(`SELECT * FROM entries ${sql} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Array<EntryRow>
  return rows.map((r) => deserializeEntry(r))
}

export function querySummaries(opts?: QueryOptions): Array<EntrySummary> {
  const db = getDatabase()
  const { sql, params } = applyWhere(opts)
  const limit = opts?.limit ?? 100
  const offset = opts?.offset ?? 0
  const rows = db
    .prepare(`SELECT id, session_id, started_at, ended_at, duration_ms, model, endpoint, transport, status,
              input_tokens, output_tokens, cache_read, cache_creation, reasoning_tokens, stop_reason, error_message
              FROM entries ${sql} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Array<Omit<EntryRow, "blob_gz">>
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id ?? undefined,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    durationMs: r.duration_ms ?? undefined,
    endpoint: r.endpoint as EntrySummary["endpoint"],
    transport: r.transport as EntrySummary["transport"],
    state: r.status as EntrySummary["state"],
    active: false,
    lastUpdatedAt: r.ended_at ?? r.started_at,
    model: r.model ?? undefined,
    inputTokens: r.input_tokens ?? undefined,
    outputTokens: r.output_tokens ?? undefined,
    cacheReadInputTokens: r.cache_read ?? undefined,
    cacheCreationInputTokens: r.cache_creation ?? undefined,
    stopReason: r.stop_reason ?? undefined,
    error: r.error_message ?? undefined,
  }) as EntrySummary)
}

export function getEntryById(id: string): HistoryEntry | undefined {
  const db = getDatabase()
  const row = db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as EntryRow | undefined
  if (!row) return undefined
  return deserializeEntry(row)
}

export function queryEntryCount(opts?: QueryOptions): number {
  const db = getDatabase()
  const { sql, params } = applyWhere(opts)
  const row = db.prepare(`SELECT COUNT(*) AS n FROM entries ${sql}`).get(...params) as { n: number }
  return row.n
}

export function listSessions(): Array<Session> {
  const db = getDatabase()
  const rows = db
    .prepare("SELECT * FROM sessions ORDER BY last_activity DESC")
    .all() as Array<{
      id: string
      start_time: number
      last_activity: number
      request_count: number
      total_input_tokens: number
      total_output_tokens: number
      models_json: string | null
      endpoints_json: string | null
      tools_used_json: string | null
    }>
  return rows.map((r) => ({
    id: r.id,
    startTime: r.start_time,
    lastActivity: r.last_activity,
    requestCount: r.request_count,
    totalInputTokens: r.total_input_tokens,
    totalOutputTokens: r.total_output_tokens,
    models: r.models_json ? (JSON.parse(r.models_json) as Array<string>) : [],
    endpoints: r.endpoints_json ? (JSON.parse(r.endpoints_json) as Session["endpoints"]) : [],
    toolsUsed: r.tools_used_json ? (JSON.parse(r.tools_used_json) as Array<string>) : undefined,
  }))
}

export function getSessionById(id: string): Session | undefined {
  return listSessions().find((s) => s.id === id)
}

export function resolveResponseSession(responseId: string): string | undefined {
  const db = getDatabase()
  const row = db
    .prepare("SELECT session_id FROM response_sessions WHERE response_id = ?")
    .get(responseId) as { session_id: string } | undefined
  return row?.session_id
}
```

Note: The `QueryOptions` type may not include every field used above. Inspect `src/lib/history/types.ts` first; add only filters supported by the existing `QueryOptions`. Any unsupported clause must be removed.

- [ ] **Step 5: Create `src/lib/history/sqlite/stats.ts`**

```typescript
import type { HistoryStats } from "~/lib/history/types"

import { getDatabase } from "./connection"

export function computeStats(): HistoryStats {
  const db = getDatabase()
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)    AS failed,
              COALESCE(SUM(input_tokens), 0)  AS total_input,
              COALESCE(SUM(output_tokens), 0) AS total_output
         FROM entries`,
    )
    .get() as { total: number; completed: number; failed: number; total_input: number; total_output: number }

  const perModel = db
    .prepare(
      `SELECT model, COUNT(*) AS count, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output
         FROM entries WHERE model IS NOT NULL GROUP BY model ORDER BY count DESC`,
    )
    .all() as Array<{ model: string; count: number; input: number; output: number }>

  return {
    totalRequests: totals.total,
    completed: totals.completed,
    failed: totals.failed,
    totalInputTokens: totals.total_input,
    totalOutputTokens: totals.total_output,
    models: perModel.map((m) => ({
      model: m.model,
      count: m.count,
      inputTokens: m.input,
      outputTokens: m.output,
    })),
  } as HistoryStats
}
```

If `HistoryStats` has additional required fields (e.g., per-endpoint counts, cache totals), inspect `src/lib/history/types.ts` and extend the query + mapping to cover them. **Do not introduce fields absent from `HistoryStats`.**

- [ ] **Step 6: Run test — expect PASS**

```bash
bun test tests/unit/history/sqlite/write-read.test.ts
bun run typecheck
```

If typecheck fails on field mismatches, adjust `serialize.ts` / `read.ts` / `stats.ts` to the actual type definitions without touching `types.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/history/sqlite tests/unit/history/sqlite/write-read.test.ts
git commit -m "feat(history/sqlite): add write/read/stats layer"
```

---

## Task 6: Reaper

**Files:**
- Create: `src/lib/history/sqlite/reaper.ts`
- Test: `tests/unit/history/sqlite/reaper.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { beforeEach, describe, expect, test } from "bun:test"

import { closeDatabase, openInMemoryDatabase } from "~/lib/history/sqlite/connection"
import { queryEntryCount } from "~/lib/history/sqlite/read"
import { runReaperOnce } from "~/lib/history/sqlite/reaper"
import { insertCompletedEntry } from "~/lib/history/sqlite/write"

function seed(n: number) {
  for (let i = 0; i < n; i++) {
    insertCompletedEntry({
      id: `e${i}`,
      endpoint: "anthropic-messages",
      startedAt: 1_000 + i,
      endedAt: 1_000 + i,
      durationMs: 0,
      state: "completed",
      active: false,
      lastUpdatedAt: 1_000 + i,
      request: { model: "m" },
      response: { success: true, model: "m", usage: { input_tokens: 0, output_tokens: 0 }, content: null },
    } as any)
  }
}

describe("reaper", () => {
  beforeEach(() => {
    closeDatabase()
    openInMemoryDatabase()
  })

  test("no-op when count <= limit", () => {
    seed(5)
    runReaperOnce(10)
    expect(queryEntryCount()).toBe(5)
  })

  test("deletes oldest beyond limit", () => {
    seed(8)
    runReaperOnce(5)
    expect(queryEntryCount()).toBe(5)
  })

  test("limit=0 disables eviction", () => {
    seed(3)
    runReaperOnce(0)
    expect(queryEntryCount()).toBe(3)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test tests/unit/history/sqlite/reaper.test.ts
```

- [ ] **Step 3: Create `src/lib/history/sqlite/reaper.ts`**

```typescript
import consola from "consola"

import { getDatabase } from "./connection"

let timer: ReturnType<typeof setInterval> | null = null

export function runReaperOnce(limit: number): number {
  if (limit <= 0) return 0
  const db = getDatabase()
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }
  if (n <= limit) return 0
  const excess = n - limit
  const result = db
    .prepare(
      `DELETE FROM entries WHERE id IN (
         SELECT id FROM entries ORDER BY started_at ASC LIMIT ?
       )`,
    )
    .run(excess)
  const deleted = Number(result.changes ?? 0)
  if (deleted > 0) consola.info(`[history/sqlite] reaper evicted ${deleted} entries (limit=${limit})`)
  return deleted
}

export function startReaper(limit: number, intervalSeconds: number): void {
  stopReaper()
  if (intervalSeconds <= 0 || limit <= 0) return
  timer = setInterval(() => {
    try {
      runReaperOnce(limit)
    } catch (err: unknown) {
      consola.warn("[history/sqlite] reaper tick failed", err)
    }
  }, intervalSeconds * 1000)
  // Avoid keeping the event loop alive solely for the reaper.
  if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
    ;(timer as { unref: () => void }).unref()
  }
}

export function stopReaper(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
bun test tests/unit/history/sqlite/reaper.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/history/sqlite/reaper.ts tests/unit/history/sqlite/reaper.test.ts
git commit -m "feat(history/sqlite): add row-count based reaper"
```

---

## Task 7: In-flight map for WebSocket snapshots

**Files:**
- Create: `src/lib/history/in-flight.ts`

Purpose: snapshot storage for currently-executing requests, used only by `queries.ts`/WebSocket notify helpers. Not persisted. Replaces the role of the old memory `entries[]`.

- [ ] **Step 1: Create `src/lib/history/in-flight.ts`**

```typescript
import type { EntrySummary, HistoryEntry } from "./types"

const entries = new Map<string, HistoryEntry>()

export function putInFlight(entry: HistoryEntry): void {
  entries.set(entry.id, entry)
}

export function updateInFlight(id: string, patch: Partial<HistoryEntry>): HistoryEntry | undefined {
  const existing = entries.get(id)
  if (!existing) return undefined
  const merged: HistoryEntry = { ...existing, ...patch }
  entries.set(id, merged)
  return merged
}

export function getInFlight(id: string): HistoryEntry | undefined {
  return entries.get(id)
}

export function removeInFlight(id: string): void {
  entries.delete(id)
}

export function listInFlight(): Array<HistoryEntry> {
  return Array.from(entries.values())
}

export function clearInFlight(): void {
  entries.clear()
}

export function toEntrySummary(entry: HistoryEntry): EntrySummary {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    durationMs: entry.durationMs,
    endpoint: entry.endpoint,
    transport: entry.transport,
    state: entry.state,
    active: entry.active,
    lastUpdatedAt: entry.lastUpdatedAt,
    model: entry.response?.model ?? entry.request?.model,
    inputTokens: entry.response?.usage?.input_tokens,
    outputTokens: entry.response?.usage?.output_tokens,
    cacheReadInputTokens: entry.response?.usage?.cache_read_input_tokens,
    cacheCreationInputTokens: entry.response?.usage?.cache_creation_input_tokens,
    stopReason: entry.response?.stop_reason,
    error: entry.response?.error,
  } as EntrySummary
}
```

If `EntrySummary` has additional fields, inspect `types.ts` and extend the mapping to cover them (mirror the existing memory-based `toSummary` in `entries.ts`).

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/history/in-flight.ts
git commit -m "feat(history): add in-flight entry map for websocket snapshots"
```

---

## Task 8: Rewire `entries.ts` / `queries.ts` to in-flight + sqlite

**Files:**
- Modify: `src/lib/history/entries.ts`
- Modify: `src/lib/history/queries.ts`

The idea:
- `insertEntry(entry)` → `putInFlight`, emit `notifyEntryAdded` with summary from in-flight. **No DB write.**
- `updateEntry(id, patch)` → `updateInFlight`; if `patch.state === "completed" || "failed"` → call `insertCompletedEntry(merged)` **then** `removeInFlight(id)` **then** `notifyEntryUpdated(summary)`. Otherwise just notify.
- `clearHistory()` → `clearInFlight()` + `clearAllEntries()` + notify.
- `evictOldestEntries()` → deprecate; keep as no-op or delegate to reaper. **Remove the export.**
- `getEntry(id)` → in-flight first, else `getEntryById(id)`.
- `getHistory(opts)` → combine in-flight (filtered) + `queryEntries(opts)`; in-flight on top, sorted by `startedAt` DESC.
- `getHistorySummaries(opts)` → combine in-flight summaries + `querySummaries(opts)`.
- `getSummary(id)` → in-flight summary first, else derive from `querySummaries` / `getEntryById`.

- [ ] **Step 1: Rewrite `src/lib/history/entries.ts`**

Replace module body with (retain `extractPreviewText` if still used for summary):

```typescript
import type { EntrySummary, HistoryEntry } from "./types"

import { notifyEntryAdded, notifyEntryUpdated, notifyHistoryCleared, notifyStatsUpdated } from "../ws"
import { clearInFlight, getInFlight, listInFlight, putInFlight, removeInFlight, toEntrySummary, updateInFlight } from "./in-flight"
import { clearAllEntries, insertCompletedEntry } from "./sqlite/write"
import { computeStats } from "./sqlite/stats"

export function insertEntry(entry: HistoryEntry): void {
  putInFlight(entry)
  notifyEntryAdded(toEntrySummary(entry))
  notifyStatsUpdated(computeStats())
}

export function updateEntry(id: string, patch: Partial<HistoryEntry>): void {
  const merged = updateInFlight(id, patch)
  if (!merged) return

  const finalized = merged.state === "completed" || merged.state === "failed"
  if (finalized) {
    try {
      insertCompletedEntry(merged)
    } catch (err: unknown) {
      // Persistence failure is non-fatal; log via consumer layer, keep in-flight history visible.
    }
    removeInFlight(id)
  }

  notifyEntryUpdated(toEntrySummary(merged))
  if (finalized) notifyStatsUpdated(computeStats())
}

export function clearHistory(): void {
  clearInFlight()
  clearAllEntries()
  notifyHistoryCleared()
  notifyStatsUpdated(computeStats())
}

export function listInFlightEntries(): Array<HistoryEntry> {
  return listInFlight()
}

export function listInFlightSummaries(): Array<EntrySummary> {
  return listInFlight().map(toEntrySummary)
}

export function getInFlightEntry(id: string): HistoryEntry | undefined {
  return getInFlight(id)
}
```

- [ ] **Step 2: Rewrite `src/lib/history/queries.ts`**

```typescript
import type { EntrySummary, HistoryEntry, HistoryResult, QueryOptions, SummaryResult } from "./types"

import { getInFlight, listInFlight, toEntrySummary } from "./in-flight"
import { getEntryById, queryEntries, queryEntryCount, querySummaries } from "./sqlite/read"

function filterInFlight<T extends { startedAt: number; state?: string; sessionId?: string }>(
  rows: Array<T>,
  opts: QueryOptions | undefined,
): Array<T> {
  return rows.filter((r) => {
    if (opts?.sessionId && r.sessionId !== opts.sessionId) return false
    if (opts?.from !== undefined && r.startedAt < opts.from) return false
    if (opts?.to !== undefined && r.startedAt > opts.to) return false
    return true
  })
}

export function getEntry(id: string): HistoryEntry | undefined {
  return getInFlight(id) ?? getEntryById(id)
}

export function getSummary(id: string): EntrySummary | undefined {
  const live = getInFlight(id)
  if (live) return toEntrySummary(live)
  const persisted = getEntryById(id)
  return persisted ? toEntrySummary(persisted) : undefined
}

export function getHistory(opts?: QueryOptions): HistoryResult {
  const live = filterInFlight(listInFlight(), opts)
  const persisted = queryEntries(opts)
  const combined = [...live, ...persisted].sort((a, b) => b.startedAt - a.startedAt)
  const total = live.length + queryEntryCount(opts)
  return { entries: combined.slice(0, opts?.limit ?? combined.length), total } as HistoryResult
}

export function getHistorySummaries(opts?: QueryOptions): SummaryResult {
  const live = filterInFlight(listInFlight().map(toEntrySummary), opts)
  const persisted = querySummaries(opts)
  const combined = [...live, ...persisted].sort((a, b) => b.startedAt - a.startedAt)
  const total = live.length + queryEntryCount(opts)
  return { summaries: combined.slice(0, opts?.limit ?? combined.length), total } as SummaryResult
}
```

If `HistoryResult` / `SummaryResult` contain different field names, match the actual types (inspect `types.ts`).

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

Fix mismatches against `types.ts` without expanding scope. Common adjustments:
- `EntrySummary.model` may not exist — move it inside another container.
- `HistoryResult.entries` may be `histories` — match the existing name.

- [ ] **Step 4: Commit**

```bash
git add src/lib/history/entries.ts src/lib/history/queries.ts
git commit -m "refactor(history): route entries/queries through in-flight map + sqlite"
```

---

## Task 9: Rewire `sessions.ts` + `stats.ts` to sqlite

**Files:**
- Modify: `src/lib/history/sessions.ts`
- Modify: `src/lib/history/stats.ts`

- [ ] **Step 1: Rewrite `src/lib/history/sessions.ts`**

Keep the existing header-based `getSessionIdFromHeaders`, `getCurrentSession`, `registerResponseSession`, `resolveResponseSessionId` signatures; back them with sqlite.

Concretely:

```typescript
import { getDatabase } from "./sqlite/connection"
import { listSessions, getSessionById as readSession, resolveResponseSession } from "./sqlite/read"
import { deleteSession as sqliteDeleteSession, upsertResponseSession } from "./sqlite/write"
import { notifySessionDeleted, notifyStatsUpdated } from "../ws"
import { computeStats } from "./sqlite/stats"
import type { Session } from "./types"

// Keep existing getSessionIdFromHeaders implementation untouched (it is pure header logic).

export function getSession(id: string): Session | undefined {
  return readSession(id)
}

export function getSessions(): Array<Session> {
  return listSessions()
}

export function getSessionEntries(id: string): Array<unknown> {
  // Delegate to queries.getHistory with sessionId filter (via imported getHistory).
  // Re-export path handled in store.ts.
  throw new Error("call getHistory({ sessionId })")
}

export function getCurrentSession(): Session | undefined {
  const all = listSessions()
  return all[0]
}

export function deleteSession(id: string): void {
  sqliteDeleteSession(id)
  notifySessionDeleted(id)
  notifyStatsUpdated(computeStats())
}

export function registerResponseSession(responseId: string, sessionId: string): void {
  upsertResponseSession(responseId, sessionId)
}

export function resolveResponseSessionId(responseId: string): string | undefined {
  return resolveResponseSession(responseId)
}

export { getSessionIdFromHeaders } from "./sessions-headers"
```

Move the existing `getSessionIdFromHeaders` pure function into a new small file `src/lib/history/sessions-headers.ts` and re-export above. (Create that file by copying the function body from the current `sessions.ts`.)

**IMPORTANT:** Inspect current `sessions.ts` and preserve the header-parsing logic verbatim in `sessions-headers.ts`. Update all existing imports of `getSessionIdFromHeaders` from `~/lib/history` — the barrel export in `store.ts`/`index.ts` must continue to expose it.

- [ ] **Step 2: Rewrite `src/lib/history/stats.ts`**

```typescript
import { computeStats } from "./sqlite/stats"
import type { HistoryStats } from "./types"

export function getStats(): HistoryStats {
  return computeStats()
}

export function exportHistory(): { entries: Array<unknown>; sessions: Array<unknown> } {
  // Minimal export: full serialization of all entries + sessions via sqlite reads.
  // Import lazily to avoid circular deps.
  // eslint-disable-next-line ts/no-require-imports
  const read = require("./sqlite/read") as typeof import("./sqlite/read")
  return { entries: read.queryEntries({ limit: 10_000_000 }), sessions: read.listSessions() }
}
```

Match the actual signature / return shape of the existing `getStats` and `exportHistory`. If `exportHistory` signs a CSV path, keep the original formatting logic; only the data source changes.

- [ ] **Step 3: Typecheck + unit tests**

```bash
bun run typecheck
bun test tests/unit/history
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/history/sessions.ts src/lib/history/sessions-headers.ts src/lib/history/stats.ts
git commit -m "refactor(history): route sessions and stats through sqlite"
```

---

## Task 10: `state.ts` / `store.ts` / `index.ts` 清理

**Files:**
- Modify: `src/lib/history/state.ts`
- Modify: `src/lib/history/store.ts`
- Modify: `src/lib/history/index.ts`
- Delete: `src/lib/history/memory-pressure.ts`

- [ ] **Step 1: Rewrite `src/lib/history/state.ts`**

```typescript
import { PATHS } from "~/lib/config/paths"
import { state } from "~/lib/state"

import { closeDatabase, openDatabase } from "./sqlite/connection"
import { startReaper, stopReaper } from "./sqlite/reaper"

let enabled = false

export const historyState = {
  get enabled(): boolean {
    return enabled
  },
}

export function isHistoryEnabled(): boolean {
  return enabled
}

export function initHistory(enable: boolean, _legacyMaxEntries?: number): void {
  enabled = enable
  if (!enable) return
  const dbPath = state.historyDbPath || PATHS.HISTORY_DB
  openDatabase(dbPath)
  startReaper(state.historyLimit, state.historyReaperInterval)
}

export function shutdownHistory(): void {
  stopReaper()
  closeDatabase()
  enabled = false
}

/** Backwards-compat shim for code still calling setHistoryMaxEntries (state.ts config reload). */
export function setHistoryMaxEntries(limit: number): void {
  startReaper(limit, state.historyReaperInterval)
}
```

- [ ] **Step 2: Update `src/lib/history/store.ts`**

Remove exports that reference `evictOldestEntries` / `setHistoryMaxEntries` if those callers are now gone, and add in-flight accessors if needed. Keep only:

```typescript
export { clearHistory, getInFlightEntry, insertEntry, listInFlightEntries, listInFlightSummaries, updateEntry } from "./entries"
export { getEntry, getHistory, getHistorySummaries, getSummary } from "./queries"
export { deleteSession, getCurrentSession, getSession, getSessionEntries, getSessions, getSessionIdFromHeaders, registerResponseSession, resolveResponseSessionId } from "./sessions"
export { exportHistory, getStats } from "./stats"
export { historyState, initHistory, isHistoryEnabled, setHistoryMaxEntries, shutdownHistory } from "./state"

export type { /* keep existing type re-exports unchanged */ } from "./types"
```

Inspect current `store.ts` type re-exports and preserve them verbatim.

- [ ] **Step 3: Update `src/lib/history/index.ts`**

Remove `startMemoryPressureMonitor` / `stopMemoryPressureMonitor` / `getMemoryPressureStats` exports. Add `shutdownHistory`.

- [ ] **Step 4: Delete `src/lib/history/memory-pressure.ts`**

```bash
rm src/lib/history/memory-pressure.ts
```

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Fix all compilation errors from removed exports. Expected breakage in:
- `src/lib/shutdown.ts` — see Task 11.
- `src/start.ts` — see Task 11.
- `src/routes/status/route.ts` — see Task 11.

- [ ] **Step 6: Commit**

```bash
git add src/lib/history/state.ts src/lib/history/store.ts src/lib/history/index.ts
git rm src/lib/history/memory-pressure.ts
git commit -m "refactor(history): replace memory store with sqlite-backed state"
```

---

## Task 11: Callers — shutdown / start / status / config

**Files:**
- Modify: `src/lib/shutdown.ts`
- Modify: `src/start.ts`
- Modify: `src/routes/status/route.ts`
- Modify: `src/routes/config/route.ts`
- Modify: `src/lib/state.ts`
- Modify: `src/lib/config/config.ts`

- [ ] **Step 1: `src/lib/state.ts`**

Inside `MutableState`:
- Remove `readonly historyMinEntries: number`.
- Add `readonly historyReaperInterval: number` (seconds; default 600).
- Add `readonly historyDbPath: string` (default empty string → means use `PATHS.HISTORY_DB`).

Inside `setHistoryConfig` signature: drop `historyMinEntries`, add `historyReaperInterval`, `historyDbPath`.

`CONFIG_MANAGED_DEFAULTS`:
- Remove `historyMinEntries`.
- Add `historyReaperInterval: 600`, `historyDbPath: ""`.

Inside `resetHistoryConfig`: update the keys accordingly; replace the `setHistoryMaxEntries` call with `setHistoryMaxEntries(CONFIG_MANAGED_DEFAULTS.historyLimit)` (unchanged).

- [ ] **Step 2: `src/lib/config/config.ts`**

Replace the `h.min_entries` branch with:

```typescript
if (h.reaper_interval !== undefined) setHistoryConfig({ historyReaperInterval: h.reaper_interval })
if (h.db_path !== undefined) setHistoryConfig({ historyDbPath: h.db_path })
if (h.min_entries !== undefined) {
  consola.warn("[config] history.min_entries is deprecated and ignored (sqlite-based history)")
}
```

Update the yaml type schema accordingly.

- [ ] **Step 3: `src/lib/shutdown.ts`**

Replace:

```typescript
stopMemoryPressureMonitor()
```
with:

```typescript
shutdownHistory()
```

Update the import at the top to drop `stopMemoryPressureMonitor` and add `shutdownHistory` from `./history`.

- [ ] **Step 4: `src/start.ts`**

Remove `import { ..., startMemoryPressureMonitor } from "./lib/history"` and the `startMemoryPressureMonitor()` call. Replace `initHistory(true, state.historyLimit)` with `initHistory(true)` (reads `state` internally).

- [ ] **Step 5: `src/routes/status/route.ts`**

Remove the `getMemoryPressureStats` import and its usage inside the status payload. Replace the relevant fields with omitted fields or a `historyBackend: "sqlite"` hint.

- [ ] **Step 6: `src/routes/config/route.ts`**

Remove `historyMinEntries` from the response body. Add `historyReaperInterval` and `historyDbPath`.

- [ ] **Step 7: Typecheck + existing tests**

```bash
bun run typecheck
bun test tests/unit/history tests/unit/config
```

Everything must pass before continuing.

- [ ] **Step 8: Commit**

```bash
git add src/lib/state.ts src/lib/config/config.ts src/lib/shutdown.ts src/start.ts src/routes/status/route.ts src/routes/config/route.ts
git commit -m "refactor(history): remove memory-pressure, expose reaper config"
```

---

## Task 12: Consumer — 仅完成态写库

**Files:**
- Modify: `src/lib/context/consumers.ts`

The current consumer calls `insertEntry` on `originalRequest` arrival and then `updateEntry` multiple times. With the new `entries.ts` logic:

- `insertEntry` → in-flight only, emits `entry_added`. Fine as-is.
- Intermediate `updateEntry` calls → in-flight update + `entry_updated` notify (no DB write). Fine as-is.
- Final `updateEntry` at `completed`/`failed` → triggers the single SQLite write inside `entries.ts`.

So the **consumer file itself doesn't need changes to its logic** — the rewiring in `entries.ts` handles the new write boundary. Still, verify:

- [ ] **Step 1: Re-read `src/lib/context/consumers.ts`**

Confirm no direct imports from `~/lib/history/sqlite/*` are needed and no dropped export (`evictOldestEntries` etc.) is referenced. If there are any, remove them.

- [ ] **Step 2: Integration test**

Create `tests/integration/history/persistence.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { HistoryEntry } from "~/lib/history"

import { insertEntry, updateEntry, getEntry } from "~/lib/history/store"
import { closeDatabase, openInMemoryDatabase } from "~/lib/history/sqlite/connection"
import { queryEntryCount } from "~/lib/history/sqlite/read"

function baseEntry(id: string): HistoryEntry {
  return {
    id,
    endpoint: "anthropic-messages",
    startedAt: Date.now(),
    state: "pending",
    active: true,
    lastUpdatedAt: Date.now(),
    request: { model: "claude-opus-4-7" },
  } as HistoryEntry
}

describe("history persistence boundary", () => {
  beforeEach(() => {
    closeDatabase()
    openInMemoryDatabase()
  })

  afterEach(() => {
    closeDatabase()
  })

  test("pending entry stays out of sqlite", () => {
    insertEntry(baseEntry("e1"))
    expect(queryEntryCount()).toBe(0)
    expect(getEntry("e1")?.state).toBe("pending")
  })

  test("only writes to sqlite on completion", () => {
    insertEntry(baseEntry("e2"))
    updateEntry("e2", { state: "streaming", active: true, lastUpdatedAt: Date.now() })
    expect(queryEntryCount()).toBe(0)

    updateEntry("e2", {
      state: "completed",
      active: false,
      lastUpdatedAt: Date.now(),
      endedAt: Date.now(),
      response: {
        success: true,
        model: "claude-opus-4-7",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: null,
      },
    })
    expect(queryEntryCount()).toBe(1)
    expect(getEntry("e2")?.state).toBe("completed")
  })
})
```

- [ ] **Step 3: Run**

```bash
bun test tests/integration/history/persistence.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/history/persistence.test.ts
git commit -m "test(history): verify write boundary (pending → in-flight, completed → sqlite)"
```

---

## Task 13: 文档同步

**Files:**
- Modify: `docs/history.md`
- Modify: `docs/DESIGN.md`

- [ ] **Step 1: Update `docs/history.md`**

- 改写"概述"为基于 SQLite 的持久化描述。
- "Memory Pressure 管理" 一节改为 "容量管理（Reaper）"：描述按行数清理、`history.limit`、`history.reaper_interval`。
- 新增 "数据库位置" 一节：`$XDG_DATA_HOME/copilot-api/history.db`，默认 fallback 路径。
- 新增"进行中 vs 持久化"一节：说明只在完成/失败后落盘。

- [ ] **Step 2: Update `docs/DESIGN.md`**

- 目录树中 `src/lib/history/` 下新增 `sqlite/`、`in-flight.ts`，移除 `memory-pressure.ts`。
- 运行时选项表中：删除 `historyMinEntries`，新增 `historyReaperInterval`、`historyDbPath`。
- `src/lib/config/paths.ts` 条目增加 `HISTORY_DB`、说明 `XDG_DATA_HOME` 覆盖。

- [ ] **Step 3: Commit (docs only, no typecheck required per Principle 9)**

```bash
git add docs/history.md docs/DESIGN.md
git commit -m "docs: describe sqlite history persistence and XDG_DATA_HOME"
```

---

## Task 14: Full build + full test

- [ ] **Step 1: Run**

```bash
bun run typecheck
bun run lint:all
bun test
```

Expected: all green. Fix any remaining references to removed symbols.

- [ ] **Step 2: Commit (if any follow-ups)**

Only if fixes needed.

---

## Self-review

- **Spec coverage**
  - 表结构 (entries + sessions + response_sessions) → Task 3
  - 按字段 meta + 合并 blob 压缩 → Task 4
  - 完成后才写 → Task 8 + Task 12
  - Reaper 10 min / 10k → Task 6 + Task 11
  - XDG_DATA_HOME → Task 1
  - REST/WebSocket 兼容 → Task 8 + Task 9
  - 移除 MemoryPressureManager / historyMinEntries → Task 10 + Task 11
  - 数据库位置在 XDG 下 → Task 1 + Task 3 + Task 10
  - 默认启用 → Task 10（`initHistory(true)`）
  - 错误处理（db 打开失败、写入失败、解压失败、事务） → Task 3 (connection) + Task 5 (write transaction) + Task 8 (write catch)
  - 测试计划 → Task 2/4/5/6/7/12

- **Type consistency**
  - `insertCompletedEntry`、`queryEntries`、`querySummaries`、`getEntryById`、`listSessions`、`runReaperOnce`、`startReaper`、`stopReaper` 在多 task 中使用同名。
  - `QueryOptions` / `HistoryEntry` / `EntrySummary` / `Session` / `HistoryStats` / `HistoryResult` / `SummaryResult` 均需要以现有 `types.ts` 为准，Task 5/7/8/9 都明确要求"检查 types.ts 并匹配实际字段"。

- **Placeholders**
  - 所有代码步骤含完整代码块；类型匹配不确定处明确指示"以 types.ts 为准，不扩大改动"。

---

Plan complete and saved to `docs/superpowers/plans/2026-04-17-sqlite-history-persistence.md`. Two execution options:

**1. Subagent-Driven (recommended)** — 派发独立 subagent 执行每个 Task，我在 Task 之间 review。适合本次跨越 14 个 Task 的改动。

**2. Inline Execution** — 在当前 session 中批量执行，带 checkpoint。

哪种方式？

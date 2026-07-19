/**
 * telemetry.db —— 独立分层遥测 SQLite 库（与 history.db 分家、生命周期另算）。
 *
 * 复用 History 的 `createDatabase`（bun:sqlite / node:sqlite 抽象，battle-tested）。
 * 采用「幂等地板」模式（对齐 history connection.ts）：`openTelemetryDb` 建全部表
 * （`CREATE TABLE IF NOT EXISTS`，可重复调用无害），forward migrations（001+）后续
 * 经 Umzug + `tel_meta` 账本追加。schema 见 spec §物理schema。
 *
 * 三层 settled rollup（tel_raw 5min / tel_hourly / tel_daily）+ 终身累计（tel_cumulative）
 * + accepted 流（tel_accepted，无维度）+ 字典编码（tel_dim/tel_key，整数替代重复字符串）。
 * cost 列 scaled-int micro（`round(cost*1e6)`，绝不 REAL——STRICT INTEGER 拒 REAL）。
 * 分布度量存 tel_*.hist_blob（DDSketch 手动序列化，见 sketch.ts）；固定桶只活在 /metrics 内存路径。
 */
import { PATHS } from "~/lib/config/paths"
import {
  //
  createDatabase,
  type SqliteDatabase,
} from "~/lib/history/sqlite/driver"

export type TelemetryDatabase = SqliteDatabase

const BUSY_TIMEOUT_MS = 5000

/** 一张 settled 层的度量列（raw/hourly/daily/cumulative 同构复用）。cost 列 micro scaled-int。 */
const SETTLED_MEASURE_COLUMNS = `
  req_count                INTEGER NOT NULL DEFAULT 0,
  success_count            INTEGER NOT NULL DEFAULT 0,
  failure_count            INTEGER NOT NULL DEFAULT 0,
  total_duration_ms        INTEGER NOT NULL DEFAULT 0,
  queue_wait_ms            INTEGER NOT NULL DEFAULT 0,
  input_tok                INTEGER NOT NULL DEFAULT 0,
  output_tok               INTEGER NOT NULL DEFAULT 0,
  cache_read_tok           INTEGER NOT NULL DEFAULT 0,
  cache_creation_tok       INTEGER NOT NULL DEFAULT 0,
  reasoning_tok            INTEGER NOT NULL DEFAULT 0,
  cost_input_micro         INTEGER NOT NULL DEFAULT 0,
  cost_output_micro        INTEGER NOT NULL DEFAULT 0,
  cost_cache_read_micro    INTEGER NOT NULL DEFAULT 0,
  cost_cache_creation_micro INTEGER NOT NULL DEFAULT 0,
  cost_reasoning_micro     INTEGER NOT NULL DEFAULT 0,
  thinking_nonempty        INTEGER NOT NULL DEFAULT 0,
  thinking_empty_signed    INTEGER NOT NULL DEFAULT 0,
  thinking_empty_unsigned  INTEGER NOT NULL DEFAULT 0,
  generation_candidates    INTEGER NOT NULL DEFAULT 0,
  upstream_dispatches      INTEGER NOT NULL DEFAULT 0,
  hedge_candidates         INTEGER NOT NULL DEFAULT 0,
  hedge_wins               INTEGER NOT NULL DEFAULT 0,
  recovery_candidates      INTEGER NOT NULL DEFAULT 0,
  cancelled_dispatches     INTEGER NOT NULL DEFAULT 0,
  unknown_usage_dispatches INTEGER NOT NULL DEFAULT 0,
  hist_blob                BLOB`

/** 幂等地板 schema：全部表 + 索引。可重复 exec 无害。 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tel_meta (key TEXT PRIMARY KEY, value TEXT) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS tel_dim (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE) STRICT;
CREATE TABLE IF NOT EXISTS tel_key (
  id  INTEGER PRIMARY KEY,
  dim INTEGER NOT NULL,
  key TEXT NOT NULL,
  UNIQUE(dim, key)
) STRICT;

CREATE TABLE IF NOT EXISTS tel_raw (
  bucket_ts INTEGER NOT NULL,
  dim       INTEGER NOT NULL,
  key_id    INTEGER NOT NULL,
  ${SETTLED_MEASURE_COLUMNS},
  PRIMARY KEY (dim, bucket_ts, key_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS tel_hourly (
  bucket_ts INTEGER NOT NULL,
  dim       INTEGER NOT NULL,
  key_id    INTEGER NOT NULL,
  ${SETTLED_MEASURE_COLUMNS},
  PRIMARY KEY (dim, bucket_ts, key_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS tel_daily (
  bucket_ts INTEGER NOT NULL,
  dim       INTEGER NOT NULL,
  key_id    INTEGER NOT NULL,
  ${SETTLED_MEASURE_COLUMNS},
  PRIMARY KEY (dim, bucket_ts, key_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS tel_cumulative (
  dim    INTEGER NOT NULL,
  key_id INTEGER NOT NULL,
  ${SETTLED_MEASURE_COLUMNS},
  PRIMARY KEY (dim, key_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS tel_accepted (
  bucket_ts INTEGER PRIMARY KEY,
  count     INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;
`

/**
 * 打开（或建）telemetry.db，设 PRAGMA + 建幂等地板 schema。返回 driver。
 * `dbPath` 默认 `PATHS.TELEMETRY_DB`；测试注入临时路径（skill test-isolation）。
 */
export function openTelemetryDb(dbPath: string = PATHS.TELEMETRY_DB): TelemetryDatabase {
  const db = createDatabase(dbPath)
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA synchronous = NORMAL;")
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
  db.exec("PRAGMA foreign_keys = ON;")
  db.exec(SCHEMA_SQL)
  ensureGenerationMeasureColumns(db)
  return db
}

function ensureGenerationMeasureColumns(db: TelemetryDatabase): void {
  const columns = [
    "generation_candidates",
    "upstream_dispatches",
    "hedge_candidates",
    "hedge_wins",
    "recovery_candidates",
    "cancelled_dispatches",
    "unknown_usage_dispatches",
  ] as const
  for (const table of ["tel_raw", "tel_hourly", "tel_daily", "tel_cumulative"] as const) {
    const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name))
    for (const column of columns) {
      if (existing.has(column)) continue
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`)
      } catch (error) {
        if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error
      }
    }
  }
}

/** 全部 settled 层表名（rollup / 裁剪 / 查询路由遍历用）。 */
export const SETTLED_TIER_TABLES = ["tel_raw", "tel_hourly", "tel_daily"] as const

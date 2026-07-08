import consola from "consola"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import {
  //
  createDatabase,
  type SqliteDatabase,
} from "~/lib/history/sqlite/driver" // runtime-agnostic factory, NO singleton

import {
  //
  keyString,
  type QuarantineKey,
} from "./session-key"

/**
 * Durable `(session, agent)` poison quarantine with a sliding TTL.
 *
 * L3 of the three-layer "thinking cannot be modified" fix: once a conversation
 * is observed to be poisoned (GHC 400 on `thinking` mutation), we remember the
 * `(session, agent)` pair here so subsequent turns are proactively stripped —
 * even across process restarts, via a sidecar SQLite DB.
 *
 * Design invariants:
 *   - **DI**: `dbPath` is a constructor parameter, never read from `PATHS`
 *     internally, so tests can point it at a temp dir and never touch the real
 *     `~/.local/share/copilot-api`. (Bun's `os.homedir()` ignores `env.HOME`,
 *     so DI is the only safe isolation.)
 *   - **In-memory cache is the read path**: `isPoisoned` reads ONLY the cache,
 *     hydrated at construction from the DB. Reads never touch disk and never
 *     throw.
 *   - **never-throw**: construction, `record`, and `touch` are wrapped so a
 *     broken/unwritable DB degrades to an in-memory-only cache (warn once) —
 *     the feature keeps working for the lifetime of the process.
 *   - **live TTL (hot-reloadable)**: `ttlMs` is a thunk (`() => number`)
 *     evaluated per `isPoisoned` call, NOT captured at construction. A
 *     hot-reloaded `poisoned_thinking_ttl_hours` config edit therefore takes
 *     effect immediately, without rebuilding the store or restarting.
 *   - **bounded growth (spec §3.3)**: `record` lazily prunes at the growth
 *     point — it purges entries older than the live TTL and enforces a `maxRows`
 *     safety cap (oldest-by-`last_seen_at` evicted first) on BOTH the cache and
 *     the DB, so neither grows monotonically. Cache pruning runs unconditionally
 *     (Map ops never throw → bounded even in degraded mode); DB pruning rides the
 *     same never-throw try/catch as the write.
 *
 * `createDatabase` does no PRAGMA/mkdir of its own, so this class self-inits:
 * `mkdir` the parent dir, set WAL + busy_timeout, and `CREATE TABLE IF NOT
 * EXISTS`.
 */

/** Default safety cap on quarantine rows / cache entries (spec §3.3). Constructor-injectable so tests assert the cap without recording 1000 rows. */
const MAX_ROWS = 1000

export class ThinkingQuarantineStore {
  private db: SqliteDatabase | null = null
  private cache = new Map<string, number>() // keyString -> lastSeenAt (ms)
  private readonly ttlMs: () => number
  private readonly maxRows: number

  // `dbPath` is a plain parameter, not a stored field: it is only needed during
  // self-init here. Parameter properties (`private readonly dbPath`) are barred
  // by tsconfig `erasableSyntaxOnly`. `maxRows` defaults to MAX_ROWS but is
  // injectable so tests can assert the cap without recording 1000 rows.
  constructor(dbPath: string, ttlMs: () => number, maxRows: number = MAX_ROWS) {
    this.ttlMs = ttlMs
    this.maxRows = maxRows
    try {
      mkdirSync(dirname(dbPath), { recursive: true })
      this.db = createDatabase(dbPath)
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS poisoned_conversations (
          session_id TEXT NOT NULL,
          agent_id TEXT NOT NULL DEFAULT '',
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          hit_count INTEGER NOT NULL DEFAULT 1,
          last_error_sample TEXT,
          PRIMARY KEY (session_id, agent_id)
        )`,
      )
      // Hydrate the cache through the SAME `keyString` encoding used by the
      // read/write paths, so hydrated keys match what `isPoisoned`/`record`/
      // `touch` look up. Do NOT hand-roll a join here.
      const rows = this.db.prepare("SELECT session_id, agent_id, last_seen_at FROM poisoned_conversations").all() as Array<{
        session_id: string
        agent_id: string
        last_seen_at: number
      }>
      for (const r of rows) {
        this.cache.set(keyString({ sessionId: r.session_id, agentId: r.agent_id }), r.last_seen_at)
      }
    } catch (e) {
      consola.warn(`[ThinkingQuarantine] init failed for ${dbPath}, degrading to in-memory:`, e instanceof Error ? e.message : e)
      this.db = null
    }
  }

  /**
   * True iff the key was recorded within the last `ttlMs`. The `ttlMs` thunk is
   * evaluated LIVE here (per call), not captured at construction, so a
   * hot-reloaded `poisoned_thinking_ttl_hours` edit takes effect immediately.
   * Cache-only; never throws.
   */
  isPoisoned(k: QuarantineKey, now = Date.now()): boolean {
    const last = this.cache.get(keyString(k))
    const ttlMs = this.ttlMs()
    return last !== undefined && now - last <= ttlMs
  }

  /**
   * Mark `(session, agent)` poisoned at `now`, sliding the TTL window. Sets the
   * cache BEFORE the DB write so a degraded (db === null) or failing store still
   * serves this key from memory.
   */
  record(k: QuarantineKey, errorSample: string, now = Date.now()): void {
    this.cache.set(keyString(k), now)
    // Lazy bounded-growth maintenance at the growth point. Cache pruning first
    // and OUTSIDE the try — Map ops never throw, so the in-memory read path
    // stays bounded even when the DB is degraded/failing.
    this.pruneCache(now)
    try {
      this.db
        ?.prepare(
          `INSERT INTO poisoned_conversations (session_id, agent_id, first_seen_at, last_seen_at, hit_count, last_error_sample)
           VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(session_id, agent_id) DO UPDATE SET
             last_seen_at = excluded.last_seen_at,
             hit_count = hit_count + 1,
             last_error_sample = excluded.last_error_sample`,
        )
        .run(k.sessionId, k.agentId, now, now, errorSample.slice(0, 500))
      // DB-side purge + cap AFTER the upsert (so the just-written row is present
      // and survives the cap), riding the same never-throw try/catch.
      this.pruneDb(now)
    } catch (e) {
      consola.warn("[ThinkingQuarantine] record failed:", e instanceof Error ? e.message : e)
    }
  }

  /**
   * Slide the TTL window for an already-known key (a poisoned conversation seen
   * again). No-op if the key is not cached — `touch` refreshes, it does not
   * create; use `record` to first quarantine a key.
   */
  touch(k: QuarantineKey, now = Date.now()): void {
    if (!this.cache.has(keyString(k))) return
    this.cache.set(keyString(k), now)
    try {
      this.db?.prepare("UPDATE poisoned_conversations SET last_seen_at = ? WHERE session_id = ? AND agent_id = ?").run(now, k.sessionId, k.agentId)
    } catch (e) {
      consola.warn("[ThinkingQuarantine] touch failed:", e instanceof Error ? e.message : e)
    }
  }

  /**
   * In-memory bounded-growth maintenance (cache only, never throws): drop
   * entries older than the live TTL, then evict oldest-by-`lastSeen` down to
   * `maxRows`. Runs unconditionally on every `record` so the read-path Map stays
   * bounded regardless of DB health.
   */
  private pruneCache(now: number): void {
    const cutoff = now - this.ttlMs()
    for (const [k, lastSeen] of this.cache) if (lastSeen < cutoff) this.cache.delete(k)
    const overflow = this.cache.size - this.maxRows
    if (overflow > 0) {
      // Oldest-first by lastSeen; evict the overflow. (`overflow` is snapshotted
      // before the loop — deleting shrinks `cache.size` under us otherwise.)
      const oldestFirst = [...this.cache.entries()].sort((a, b) => a[1] - b[1]).slice(0, overflow)
      for (const [k] of oldestFirst) this.cache.delete(k)
    }
  }

  /**
   * DB-side mirror of {@link pruneCache}: purge expired rows, then trim to the
   * newest `maxRows` by `last_seen_at`. Best-effort — the caller wraps it in the
   * never-throw try/catch, and it no-ops when the DB is degraded (`db === null`).
   */
  private pruneDb(now: number): void {
    if (!this.db) return
    this.db.prepare("DELETE FROM poisoned_conversations WHERE last_seen_at < ?").run(now - this.ttlMs())
    this.db
      .prepare(
        `DELETE FROM poisoned_conversations WHERE rowid NOT IN (
           SELECT rowid FROM poisoned_conversations ORDER BY last_seen_at DESC LIMIT ?
         )`,
      )
      .run(this.maxRows)
  }
}

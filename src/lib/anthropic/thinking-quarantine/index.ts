/**
 * Process-wide singleton assembly for the durable thinking-quarantine store (L3).
 *
 * The {@link ThinkingQuarantineStore} class itself is DI-pure — its `dbPath` and
 * `ttlMs` are constructor parameters, never read from `PATHS`/`state` internally,
 * so tests point it at a temp dir. This module is the ONE place that wires the
 * class to the real process paths + config, exposed as a LAZY singleton:
 *
 *   - **lazy**: the store (and its SQLite `mkdir` + `CREATE TABLE`) is built on
 *     first use — the first successful strip-all retry commit — NOT at import
 *     time. So merely importing the strategy never touches disk, and the DB file
 *     is created only once quarantine actually fires.
 *   - **TTL from config at first build**: `state.poisonedThinkingTtlHours` is read
 *     when the singleton is constructed. (The store caches `ttlMs` for its
 *     lifetime; a later `config.yaml` TTL edit takes effect on the next process
 *     start. The master on/off switch `poisonedThinkingQuarantine` is re-read
 *     per-commit in the strategy, so disabling L3 is hot.)
 *   - **DI-friendly**: the strategy factory accepts a `store` override for tests;
 *     production omits it and falls through to this singleton.
 */

import { PATHS } from "~/lib/config/paths"
import { state } from "~/lib/state"

import { ThinkingQuarantineStore } from "./store"

let singleton: ThinkingQuarantineStore | null = null

/**
 * The process-wide durable poison store, built lazily on first call from
 * `PATHS.THINKING_QUARANTINE_DB` + `state.poisonedThinkingTtlHours`.
 */
export function getQuarantineStore(): ThinkingQuarantineStore {
  singleton ??= new ThinkingQuarantineStore(PATHS.THINKING_QUARANTINE_DB, state.poisonedThinkingTtlHours * 3600_000)
  return singleton
}

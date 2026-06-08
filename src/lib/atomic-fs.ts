/**
 * Atomic JSON persistence primitives.
 *
 * Two complementary tools used together by every consumer:
 *
 *   1. `atomicWriteJson(path, data)` — writes via a sibling temp file then
 *      `rename()` into place. POSIX `rename` is atomic on the same filesystem,
 *      so a crash mid-write leaves the previous file intact instead of leaving
 *      a truncated JSON that `JSON.parse` would later reject (and the loader's
 *      catch{} would silently wipe).
 *
 *   2. `createSerializedAsyncFn(fn)` — wraps an async function so concurrent
 *      callers run in turn instead of overlapping. Each call captures the
 *      latest state at its own turn. Without this, a debounce that allows two
 *      writes to race can still produce interleaved temp files where the older
 *      one wins the `rename()`, masking newer state.
 *
 * Together they cover the two ways an at-rest JSON file can be lost:
 * partial writes (atomic write fixes) and racing-snapshot writes (serialization
 * fixes). Loaders that wrap `JSON.parse` in catch{} silently zero out
 * everything when either failure mode lands, so neither is optional.
 */

import fs from "node:fs/promises"
import path from "node:path"

/**
 * Monotonic counter appended to temp file names so two `atomicWriteJson` calls
 * in the same millisecond from the same process can never collide on the same
 * tmp path. Combined with `process.pid`, `Date.now()`, and a random suffix the
 * collision space is large enough that two writers will never select the same
 * tmp file under realistic load — important when a caller bypasses the
 * `createSerializedAsyncFn` wrapper and issues concurrent raw writes.
 */
let tmpSeq = 0

/**
 * Atomically replace `targetPath` with the JSON-encoded `data`.
 *
 * Uses a sibling tmp path with `<pid>.<ts>.<seq>.<random>` so multiple
 * processes / same-process concurrent calls never collide. On any failure the
 * temp file is best-effort unlinked (fire-and-forget — the unlink runs after
 * this function's promise has settled) and the error is re-thrown. Callers
 * decide whether to log or swallow.
 *
 * The temp file lives in the same directory as `targetPath` so the final
 * `rename()` stays within one filesystem and remains atomic. Caller is
 * responsible for ensuring the target directory exists.
 */
export async function atomicWriteJson(targetPath: string, data: unknown): Promise<void> {
  const dir = path.dirname(targetPath)
  const base = path.basename(targetPath)
  const tmpPath = path.join(dir, `${base}.tmp.${process.pid}.${Date.now()}.${tmpSeq++}.${Math.random().toString(36).slice(2, 8)}`)
  try {
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8")
    await fs.rename(tmpPath, targetPath)
  } catch (err) {
    void fs.unlink(tmpPath).catch(() => undefined)
    throw err
  }
}

/**
 * Wrap an async function so its invocations execute serially: each call waits
 * for the previous to settle before starting. Returned promise resolves with
 * the caller's own invocation result.
 *
 * The internal chain is rejection-tolerant — one failure does not poison
 * subsequent calls. The returned promise of a failing call still rejects so
 * the caller sees the error.
 *
 * Use for any "persist current snapshot" operation that may be triggered from
 * multiple sources (periodic timer, shutdown hook, ad-hoc flush): without
 * serialization, two snapshots taken at different moments can land in any
 * order on disk, last-writer-wins is non-deterministic.
 */
export function createSerializedAsyncFn<Args extends ReadonlyArray<unknown>, R>(fn: (...args: Args) => Promise<R>): (...args: Args) => Promise<R> {
  let chain: Promise<unknown> = Promise.resolve()
  return (...args: Args): Promise<R> => {
    const next = chain.then(() => fn(...args))
    // Swallow rejections on the chain itself; each caller's own returned
    // promise still rejects with its own error.
    chain = next.catch(() => undefined)
    return next
  }
}

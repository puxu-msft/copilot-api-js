import { createRequire } from "node:module"
import path from "node:path"

export interface TantivySearchHit {
  operationId: string
  createdAt: number
  score: number
}

/** Stateful handle over one on-disk Tantivy index (napi class instance). */
export interface NativeHistoryIndex {
  /** Stage an upsert. Does NOT commit — call `flush` to persist a batch. */
  upsert(operationId: string, operationKind: string, createdAt: number, content: string): Promise<void>
  /** Commit all staged documents in a single segment and reload the reader. */
  flush(): Promise<void>
  search(query: string, operationKind: string | undefined, limit: number): Promise<Array<TantivySearchHit>>
  /** Flush any staged documents before the handle is released. */
  close(): Promise<void>
}

/** Native module surface: a constructor for the stateful index handle. */
export interface NativeHistorySearchModule {
  HistoryIndex: new (path: string) => NativeHistoryIndex
}

let nativeModule: Promise<NativeHistorySearchModule> | undefined
let nativeOverride: NativeHistorySearchModule | undefined
const require = createRequire(import.meta.url)

function candidates(): Array<string> {
  return [
    path.resolve(import.meta.dirname, "../../../native/history-search/copilot_history_search.node"),
    path.resolve(import.meta.dirname, "history-search.node"),
  ]
}

async function loadNative(): Promise<NativeHistorySearchModule> {
  if (nativeOverride) return nativeOverride
  const failures: Array<string> = []
  for (const candidate of candidates()) {
    try {
      return require(candidate) as NativeHistorySearchModule
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`[history-search] native Tantivy module unavailable\n${failures.join("\n")}`)
}

export function getNativeHistorySearch(): Promise<NativeHistorySearchModule> {
  return (nativeModule ??= loadNative())
}

/**
 * Whether the native module can be loaded RIGHT NOW, without throwing.
 *
 * The `.node` artifact is a build product that `.gitignore` excludes, so it is absent in any fresh
 * worktree and on any machine without a Rust toolchain — and it is no longer built by `bun install`.
 * Tests that genuinely need it gate on this instead of failing, because a red that everyone learns
 * to wave away is worse than an honest skip (2026-07-28: exactly that red was misread as a
 * pre-existing failure). Anything that runs it for real must build it first.
 */
export function isNativeHistorySearchAvailable(): boolean {
  if (nativeOverride) return true
  return candidates().some((candidate) => {
    try {
      require.resolve(candidate)
      return true
    } catch {
      return false
    }
  })
}

export function setNativeHistorySearchForTests(value: NativeHistorySearchModule | undefined): void {
  nativeOverride = value
  nativeModule = undefined
}

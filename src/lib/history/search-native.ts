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

export function setNativeHistorySearchForTests(value: NativeHistorySearchModule | undefined): void {
  nativeOverride = value
  nativeModule = undefined
}

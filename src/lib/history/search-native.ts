import { createRequire } from "node:module"
import path from "node:path"

export interface TantivySearchHit {
  operationId: string
  createdAt: number
  score: number
}

interface NativeHistorySearch {
  initialize(path: string): Promise<void>
  upsertOperation(path: string, operationId: string, operationKind: string, createdAt: number, content: string): Promise<void>
  searchOperations(path: string, query: string, operationKind: string | undefined, limit: number): Promise<Array<TantivySearchHit>>
}

let nativeModule: Promise<NativeHistorySearch> | undefined
let nativeOverride: NativeHistorySearch | undefined
const require = createRequire(import.meta.url)

function candidates(): Array<string> {
  return [
    path.resolve(import.meta.dirname, "../../../native/history-search/copilot_history_search.node"),
    path.resolve(import.meta.dirname, "history-search.node"),
  ]
}

async function loadNative(): Promise<NativeHistorySearch> {
  if (nativeOverride) return nativeOverride
  const failures: Array<string> = []
  for (const candidate of candidates()) {
    try {
      return require(candidate) as NativeHistorySearch
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`[history-search] native Tantivy module unavailable\n${failures.join("\n")}`)
}

export function getNativeHistorySearch(): Promise<NativeHistorySearch> {
  return (nativeModule ??= loadNative())
}

export function setNativeHistorySearchForTests(value: NativeHistorySearch | undefined): void {
  nativeOverride = value
  nativeModule = undefined
}

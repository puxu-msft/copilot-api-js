/** Confirm the over-match the round-5 review names: a short term as a bare substring. */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { getNativeHistorySearch, type NativeHistoryListSearchRequest } from "../../src/lib/history/search-native"

function corpusMatchesSearch(text: string, needle: string): boolean {
  const haystack = text.toLowerCase()
  const terms = needle
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  if (terms.length <= 1) return haystack.includes(needle.toLowerCase())
  return terms.some((term) => haystack.includes(term))
}

const CASES: Array<[corpus: string, needle: string]> = [
  ["cartoon", "a zzzabsent"],
  ["please fix the hello-world bug", "a qqqabsent"],
  ["please fix the hello-world bug", "zzzabsent qqqabsent"],
]

const directory = mkdtempSync(path.join(tmpdir(), "overmatch-probe-"))
const baseRequest: NativeHistoryListSearchRequest = {
  query: "",
  operationKinds: [],
  states: [],
  targetCommittedAt: 10,
  targetOperationIds: [],
  direction: "older",
  limit: 10,
}

try {
  const { HistoryIndex } = await getNativeHistorySearch()
  for (const [index_, [corpus, needle]] of CASES.entries()) {
    const handle = new HistoryIndex(path.join(directory, `cell-${index_}`))
    await handle.upsertSummary({
      operationId: `op-${index_}`,
      operationKind: "generation",
      createdAt: 1,
      committedAt: 5,
      content: corpus,
      sessionId: "s",
    })
    await handle.flush()
    const indexed = (await handle.listSearch({ ...baseRequest, query: needle })).total > 0
    console.log(`corpus=${JSON.stringify(corpus).padEnd(34)} needle=${JSON.stringify(needle).padEnd(24)} index=${indexed} overlay=${corpusMatchesSearch(corpus, needle)}`)
    await handle.close()
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}

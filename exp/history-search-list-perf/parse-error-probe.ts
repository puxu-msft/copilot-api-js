/**
 * Probe: what does a Tantivy query-syntax error look like on the JS side after the native module
 * reports it as `Status::InvalidArg`, and does an empty-string filter still empty the result?
 *
 * The whole 503→400 fix rests on that status crossing the napi boundary as a distinguishable
 * property. Reading napi-rs docs is not evidence about this binary, so this asks the artifact.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { getNativeHistorySearch, type NativeHistoryListSearchRequest } from "../../src/lib/history/search-native"

const directory = mkdtempSync(path.join(tmpdir(), "history-search-parse-probe-"))
const baseRequest: NativeHistoryListSearchRequest = {
  query: "hello",
  operationKinds: [],
  states: [],
  targetCommittedAt: 10,
  targetOperationIds: [],
  direction: "older",
  limit: 10,
}

try {
  const { HistoryIndex } = await getNativeHistorySearch()
  const index = new HistoryIndex(directory)
  await index.upsertSummary({
    operationId: "op-a",
    operationKind: "generation",
    createdAt: 1,
    committedAt: 1,
    content: "hello world",
    endpoint: "anthropic-messages",
    state: "completed",
    sessionId: "s-1",
    requestModel: "m",
    responseModel: "m",
  })
  await index.flush()

  for (const query of ["hello", "(x", "error:", "-lead", 'unclosed "quote', "a AND", "C++", "50%"]) {
    try {
      const result = await index.listSearch({ ...baseRequest, query })
      console.log(`${JSON.stringify(query).padEnd(18)} OK    total=${result.total}`)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      console.log(`${JSON.stringify(query).padEnd(18)} THROW code=${JSON.stringify(code)} message=${(error as Error).message.slice(0, 50)}`)
    }
  }

  // The empty-string filter is the second half of the same fix: no document carries an empty
  // endpoint, so resolving it as a term used to reject every document.
  const unfiltered = await index.listSearch(baseRequest)
  const emptyEndpoint = await index.listSearch({ ...baseRequest, endpoint: "" })
  const emptyStates = await index.listSearch({ ...baseRequest, states: [""] })
  const realEndpoint = await index.listSearch({ ...baseRequest, endpoint: "anthropic-messages" })
  const absentEndpoint = await index.listSearch({ ...baseRequest, endpoint: "gemini-generate-content" })
  console.log(
    `unfiltered=${unfiltered.total} endpoint=""→${emptyEndpoint.total} states=[""]→${emptyStates.total} ` +
      `endpoint=anthropic→${realEndpoint.total} endpoint=gemini→${absentEndpoint.total}`,
  )
  await index.close()
} finally {
  rmSync(directory, { recursive: true, force: true })
}

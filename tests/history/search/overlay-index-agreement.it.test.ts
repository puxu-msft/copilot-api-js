/**
 * The overlay answers for rows the index has not indexed yet, so the two must not disagree in the
 * direction that hides a row: **whatever the index returns, the overlay must also return.**
 *
 * This property has now been written into a comment three times and falsified by a probe three
 * times — as "the overlay only over-matches" (false: `hello world` vs `hello-world`), then as ASCII
 * term-splitting (false for every non-Latin script), then as requiring every term (false: the query
 * parser is OR by default). Each description was plausible and each was wrong about a detail of a
 * tokenizer nobody here wrote.
 *
 * So it stops being a description. The real index is the oracle: each row below is indexed for real,
 * queried for real, and the overlay must agree wherever the index says yes. A future change to
 * either side turns this red instead of quietly hiding rows for a few seconds at a time.
 */
import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { HistoryEntry } from "~/lib/history/types"

import {
  //
  clearInFlight,
  putInFlight,
} from "~/lib/history/in-flight"
import { listHistoryOverlaySummaries } from "~/lib/history/queries"
import {
  //
  getNativeHistorySearch,
  isNativeHistorySearchAvailable,
} from "~/lib/history/search-native"

const tmpDirs: Array<string> = []
function freshDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  clearInFlight()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function liveEntry(content: string): HistoryEntry {
  return {
    id: "overlay-row",
    operationKind: "generation",
    startedAt: 100,
    endpoint: "anthropic-messages",
    state: "streaming",
    active: true,
    clientRequest: { model: "m", messages: [{ role: "user", content }] },
    clientResponse: {},
    attempts: [],
    model: {},
  }
}

/**
 * Pairs chosen to span the ways the two tokenizers can drift apart: punctuation inside a word,
 * a query term the row lacks, non-Latin scripts, digits, and a pair that genuinely matches nothing.
 */
const PAIRS: Array<[corpus: string, needle: string]> = [
  ["please fix the hello-world bug", "hello world"],
  ["please fix the hello-world bug", "fix the parser bug"],
  ["please fix the hello-world bug", "hello zzzabsent"],
  ["please fix the hello-world bug", "zzzabsent qqqabsent"],
  ["retry after a 429 response", "429 rate limit"],
  ["你好，世界", "你好 世界"],
  ["修复 错误 in the parser", "错误 timeout"],
  ["значение по умолчанию", "значение умолчанию"],
  ["Grüße aus München", "grüße münchen"],
  ["config.yaml was reloaded", "config yaml"],
]

describe.skipIf(!isNativeHistorySearchAvailable())("overlay and index agree in the direction that matters", () => {
  test("the overlay returns every row the real index returns", async () => {
    const { HistoryIndex } = await getNativeHistorySearch()
    const disagreements: Array<string> = []

    for (const [corpus, needle] of PAIRS) {
      const index = new HistoryIndex(path.join(freshDir("overlay-agreement-"), "index"))
      await index.upsertSummary({
        operationId: "overlay-row",
        operationKind: "generation",
        createdAt: 100,
        committedAt: 5,
        content: corpus,
        sessionId: "s",
      })
      await index.flush()
      const indexed =
        (
          await index.listSearch({
            query: needle,
            operationKinds: [],
            states: [],
            targetCommittedAt: 10,
            targetOperationIds: [],
            direction: "older",
            limit: 10,
          })
        ).total > 0
      await index.close()

      clearInFlight()
      putInFlight(liveEntry(corpus))
      const overlay = listHistoryOverlaySummaries(needle).length > 0

      // Only one direction is a defect. The overlay matching MORE than the index shows a row early,
      // which is why this is an implication and not an equality.
      if (indexed && !overlay) disagreements.push(`index matched but overlay did not: corpus=${JSON.stringify(corpus)} needle=${JSON.stringify(needle)}`)
    }

    expect(disagreements).toEqual([])
  })

  test("the overlay still refuses a needle that shares nothing with the row", () => {
    putInFlight(liveEntry("please fix the hello-world bug"))
    expect(listHistoryOverlaySummaries("zzzabsent qqqabsent")).toEqual([])
    expect(listHistoryOverlaySummaries("hello")).toHaveLength(1)
  })
})

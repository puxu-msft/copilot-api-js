/**
 * P4a new-path lock (RFC 2026-07-07 history-data-model-restructure).
 *
 * The P0 golden (restructure-golden.it.test.ts) proves the `new leg ?? legacy`
 * fallback keeps a LEGACY-ONLY entry byte-identical — but a legacy-only entry has
 * NO per-attempt `upstreamRequest`/`upstreamResponse` legs, so it exercises ONLY
 * the fallback arm and can NOT prove the read-side consumers actually migrated to
 * the new legs. This file closes that gap the same way the P2.6 re-point gate does:
 * it drives each migrated consumer with an entry that carries ONLY the new legs
 * (the deprecated top-level `outboundResponse`/`outboundRequest`/`sseEvents`/… are
 * ABSENT), and asserts the consumer still reads the correct value — proving the
 * read came from `attempts[final]` / `clientResponse` / `_index.derived` / `model`,
 * not from a (here-absent) legacy leg.
 *
 * 承重 (R4-FAIL-A): the `rewrites-req` case is the load-bearing one — an entry with
 * only `attempts[final].upstreamRequest.messages` (no `outboundRequest`) MUST still
 * produce a non-empty rewrites-req, or search silently loses the wire-messages diff.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntryData } from "~/lib/context/types"
import type {
  //
  HistoryEntry,
  MessageContent,
  SseEventRecord,
} from "~/lib/history/types"

import {
  //
  resolveAttemptCount,
  resolveCurrentStrategy,
  resolveResponseError,
  resolveResponseModel,
  resolveResponseSuccess,
  resolveResponseUsage,
  resolveStopReason,
} from "~/lib/history/entry-view"
import {
  //
  clearInFlight,
  putInFlight,
  toEntrySummary,
} from "~/lib/history/in-flight"
import { getHistory } from "~/lib/history/queries"
import {
  //
  closeDatabase,
  openInMemoryDatabase,
} from "~/lib/history/sqlite/connection"
import { buildSearchIndexForEntry } from "~/lib/history/sqlite/search-index-write"
import { getStats } from "~/lib/history/stats"
import {
  //
  initHistory,
  shutdownHistory,
} from "~/lib/history/store"
import {
  //
  extractThinkingBlockCounts,
  extractToolNames,
  TELEMETRY_DIMENSIONS,
} from "~/lib/observability/telemetry-dimensions"
import { setHistoryConfig } from "~/lib/state"

function msg(role: string, content: string): MessageContent {
  return { role, content }
}

function sse(offsetMs: number, type: string, raw: string): SseEventRecord {
  return { offsetMs, type, raw }
}

/**
 * A HistoryEntry carrying ONLY the new client/upstream legs — no deprecated
 * top-level `outboundResponse` / `outboundRequest` / `effectiveRequest` /
 * `sseEvents` / `inboundResponse`. So any correct read MUST come from the new legs.
 */
function newLegEntry(over: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: "p4a-newleg",
    endpoint: "anthropic-messages",
    startedAt: 1_700_000_000_000,
    state: "completed",
    active: false,
    clientRequest: { model: "claude-opus-4-7", messages: [msg("user", "hello world")] },
    ...over,
  } as HistoryEntry
}

/** buildRewritesReq output for an entry (via the pure search-index builder). */
function rewritesReq(entry: HistoryEntry): string {
  return buildSearchIndexForEntry(entry).aux.find((a) => a.source === "rewrites-req")?.text ?? ""
}

/** buildRewritesResp output for an entry. */
function rewritesResp(entry: HistoryEntry): string {
  return buildSearchIndexForEntry(entry).aux.find((a) => a.source === "rewrites-resp")?.text ?? ""
}

describe("P4a: rewrites facets read the new upstream/client legs", () => {
  test("承重 R4-FAIL-A: rewrites-req reads attempts[final].upstreamRequest.messages (no outboundRequest)", () => {
    const entry = newLegEntry({
      clientRequest: { model: "claude-opus-4-7", messages: [msg("user", "hello world")] },
      attempts: [
        {
          index: 0,
          durationMs: 1,
          // NEW leg only — the wire messages projection lives here, NOT on outboundRequest.
          upstreamRequest: { messages: [msg("user", "hello world [proxy-rewritten]")] },
        },
      ],
    })
    const rw = rewritesReq(entry)
    // Non-empty proves buildRewritesReq reached the upstreamRequest.messages diff
    // (the fallback `outboundRequest` is ABSENT), and the injected marker surfaces.
    expect(rw.length).toBeGreaterThan(0)
    expect(rw).toContain("proxy-rewritten")
  })

  test("rewrites-req is empty when neither upstreamRequest nor outboundRequest carries messages", () => {
    const entry = newLegEntry({ attempts: [{ index: 0, durationMs: 1 }] })
    expect(rewritesReq(entry)).toBe("")
  })

  test("rewrites-resp reads upstreamResponse.sseEvents (upstream) + clientResponse.sseEvents (forwarded)", () => {
    const entry = newLegEntry({
      attempts: [
        {
          index: 0,
          durationMs: 1,
          upstreamResponse: { success: true, sseEvents: [sse(0, "content_block_delta", `data: {"upstream":true}`)] },
        },
      ],
      clientResponse: { sseEvents: [sse(0, "content_block_delta", `data: {"forwarded":true}`)] },
    })
    const rw = rewritesResp(entry)
    // The frame align surfaces the changed raw payloads from BOTH the new legs
    // (no top-level `sseEvents` / `inboundResponse` present).
    expect(rw).toContain("upstream")
    expect(rw).toContain("forwarded")
  })
})

describe("P4a: response resolvers read new legs (no legacy outboundResponse)", () => {
  const entry = newLegEntry({
    attempts: [
      {
        index: 0,
        durationMs: 1,
        error: "boom",
        upstreamResponse: {
          success: false,
          model: "resolved-model-x",
          usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 3 },
          stopReason: "max_tokens",
        },
      },
    ],
  })

  test("resolveResponseModel / Usage / StopReason / Error / Success read attempts[final].upstreamResponse", () => {
    expect(resolveResponseModel(entry)).toBe("resolved-model-x")
    expect(resolveResponseUsage(entry)?.input_tokens).toBe(11)
    expect(resolveResponseUsage(entry)?.cache_read_input_tokens).toBe(3)
    expect(resolveStopReason(entry)).toBe("max_tokens")
    expect(resolveResponseError(entry)).toBe("boom") // attempt-level error home
    expect(resolveResponseSuccess(entry)).toBe(false) // false preserved, not treated as absent
  })

  test("resolveResponseSuccess prefers _index.derived.responseSuccess over the attempt leg", () => {
    const e = newLegEntry({
      _index: { derived: { responseSuccess: true } },
      attempts: [{ index: 0, durationMs: 1, upstreamResponse: { success: false } }],
    })
    expect(resolveResponseSuccess(e)).toBe(true)
  })

  test("resolveAttemptCount / resolveCurrentStrategy read _index.derived (no top-level fields)", () => {
    const e = newLegEntry({ _index: { derived: { attemptCount: 5, currentStrategy: "ws-fallback" } } })
    expect(resolveAttemptCount(e)).toBe(5)
    expect(resolveCurrentStrategy(e)).toBe("ws-fallback")
  })
})

describe("P4a: toEntrySummary projects from the new legs", () => {
  test("responseModel/Success/usage from upstreamResponse; attemptCount/currentStrategy from _index.derived", () => {
    const entry = newLegEntry({
      _index: { derived: { attemptCount: 3, currentStrategy: "primary" } },
      attempts: [
        {
          index: 0,
          durationMs: 1,
          upstreamResponse: { success: true, model: "resolved-model-y", usage: { input_tokens: 7, output_tokens: 8 } },
        },
      ],
    })
    const s = toEntrySummary(entry)
    expect(s.attemptCount).toBe(3)
    expect(s.currentStrategy).toBe("primary")
    expect(s.responseModel).toBe("resolved-model-y")
    expect(s.responseSuccess).toBe(true)
    expect(s.usage?.input_tokens).toBe(7)
  })
})

describe("P4a: telemetry (HistoryEntryData) reads new legs", () => {
  const ctxStub = {} as never
  const modelDim = TELEMETRY_DIMENSIONS.find((d) => d.name === "model")

  function makeData(over: Partial<HistoryEntryData>): HistoryEntryData {
    return {
      id: "p4a-td",
      endpoint: "anthropic-messages",
      startedAt: 0,
      endedAt: 1,
      state: "completed",
      active: false,
      lastUpdatedAt: 1,
      queueWaitMs: 0,
      durationMs: 1,
      ...over,
    } as HistoryEntryData
  }

  test("model dimension reads model.resolved → model.requested; no `model` key → 'unknown'", () => {
    expect(modelDim?.extract(makeData({ model: { resolved: "m-res", requested: "m-req" } }), ctxStub)).toBe("m-res")
    expect(modelDim?.extract(makeData({ model: { requested: "m-req" } }), ctxStub)).toBe("m-req")
    // The legacy inboundRequest fallback was removed in P4c-3: an absent `model` key
    // resolves to "unknown" (there is no other source for the dimension key).
    expect(modelDim?.extract(makeData({}), ctxStub)).toBe("unknown")
  })

  test("extractToolNames reads attempts[final].upstreamResponse.body (no outboundResponse.content)", () => {
    const entry = makeData({
      attempts: [
        {
          index: 0,
          durationMs: 1,
          upstreamResponse: {
            success: true,
            body: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
          },
        },
      ],
    })
    expect(extractToolNames(entry)).toEqual(["Read"])
  })

  test("extractThinkingBlockCounts reads attempts[final].upstreamResponse.body", () => {
    const entry = makeData({
      attempts: [
        {
          index: 0,
          durationMs: 1,
          upstreamResponse: {
            success: true,
            body: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "real reasoning", signature: "sig" },
                { type: "thinking", thinking: "", signature: "sig2" },
                { type: "thinking", thinking: "", signature: "" },
              ],
            },
          },
        },
      ],
    })
    expect(extractThinkingBlockCounts(entry)).toEqual({ nonEmpty: 1, emptySigned: 1, emptyUnsigned: 1 })
  })
})

describe("P4a: getStats / getHistory wiring reads new legs (in-flight, DB-backed)", () => {
  beforeEach(async () => {
    await shutdownHistory()
    clearInFlight()
    setHistoryConfig({ historyDbPath: ":memory:" })
    initHistory(true)
    openInMemoryDatabase()
  })

  afterEach(async () => {
    clearInFlight()
    await shutdownHistory()
    closeDatabase()
    setHistoryConfig({ historyDbPath: "" })
  })

  test("getStats counts model/usage/success from the in-flight entry's upstreamResponse", () => {
    putInFlight(
      newLegEntry({
        id: "p4a-stats-1",
        attempts: [
          {
            index: 0,
            durationMs: 1,
            upstreamResponse: { success: true, model: "resolved-model-z", usage: { input_tokens: 100, output_tokens: 200 } },
          },
        ],
      }),
    )
    const stats = getStats()
    expect(stats.modelDistribution["resolved-model-z"]).toBe(1)
    expect(stats.totalInputTokens).toBe(100)
    expect(stats.totalOutputTokens).toBe(200)
    expect(stats.successfulRequests).toBe(1)
  })

  test("getHistory model filter matches on upstreamResponse.model (no outboundResponse)", () => {
    putInFlight(
      newLegEntry({
        id: "p4a-query-1",
        clientRequest: { model: "inbound-req-model", messages: [msg("user", "hi")] },
        attempts: [{ index: 0, durationMs: 1, upstreamResponse: { success: true, model: "resolved-query-model" } }],
      }),
    )
    // Filtering by the RESOLVED model (only present on the new upstream leg) must hit.
    const hit = getHistory({ model: "resolved-query" })
    expect(hit.entries.map((e) => e.id)).toContain("p4a-query-1")
    // A model that matches neither inbound nor resolved must miss.
    const miss = getHistory({ model: "no-such-model" })
    expect(miss.entries.map((e) => e.id)).not.toContain("p4a-query-1")
  })
})

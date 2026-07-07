/**
 * P4c-1 producer completion lock (RFC 2026-07-07 history-data-model-restructure).
 *
 * P4a/P4b migrated the read consumers to the new client/upstream legs
 * (`model{}` / `_index.derived` / `attempts[].upstreamResponse` / `clientResponse`),
 * but the PRODUCER (`toHistoryEntry`) did not yet POPULATE `model` / `clientRequest`
 * / `_index.derived` / `preprocessing` / `attempts[].{startedAt,waitMs,
 * effectiveSource.pipeline}` — so the resolver's `new ?? legacy` chain kept
 * falling through to the legacy leg. This file drives a REAL RequestContext through
 * `toHistoryEntry()` and asserts:
 *
 *   1. Every new field is populated, and its value is SEMANTICALLY EQUIVALENT to the
 *      legacy field it mirrors (so a consumer switched to the new leg reads the same
 *      value).
 *   2. The migrated consumers (entry-view resolvers + telemetry model dimension) now
 *      read from the REAL populated new legs — proven with the "delete the legacy
 *      top-level, assert the read is still correct" technique (the read MUST have
 *      come from `_index.derived` / `upstreamResponse` / `model`, not the deleted leg).
 */

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry } from "~/lib/history/types"

import { createRequestContext } from "~/lib/context/request"
import { HTTPError } from "~/lib/error"
import {
  //
  resolveAttemptCount,
  resolveCurrentStrategy,
  resolveResponseModel,
  resolveResponseSuccess,
  resolveResponseUsage,
} from "~/lib/history/entry-view"
import { TELEMETRY_DIMENSIONS } from "~/lib/observability/telemetry-dimensions"
import { state } from "~/lib/state"

// ─── Fixtures ───

const REQUESTED = "gpt-4o-client-alias" // raw inbound model (client alias)
const RESOLVED = "gpt-4o" // resolved model (normalizeModelId is identity for this)
const MULTIPLIER = 3

/** Register a billing entry for RESOLVED so the producer resolves `model.multiplier`. */
function withBilling(): void {
  state.modelIndex.set(RESOLVED, {
    id: RESOLVED,
    name: RESOLVED,
    object: "model",
    vendor: "OpenAI",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    is_chat_default: false,
    is_chat_fallback: false,
    billing: { multiplier: MULTIPLIER },
  })
}

afterEach(() => {
  state.modelIndex.delete(RESOLVED)
})

const INBOUND_MESSAGES = [{ role: "user", content: "hello there" }]
const INBOUND_SYSTEM = "you are a helpful assistant"
const INBOUND_TOOLS = [{ name: "get_weather", description: "get weather" }]

/**
 * Drive a REAL RequestContext through a full successful multi-attempt flow (with a
 * rate-limit wait, a sanitization pass, a truncation on the retry, and inbound
 * preprocessing) and return the produced entry.
 */
function driveSuccess(): HistoryEntry {
  withBilling()
  const ctx = createRequestContext({ endpoint: "openai-chat-completions", method: "POST", path: "/chat/completions" })
  ctx.setResolvedModel({ resolved: RESOLVED, client: REQUESTED })
  ctx.setOriginalRequest({
    model: REQUESTED,
    messages: INBOUND_MESSAGES,
    stream: true,
    tools: INBOUND_TOOLS,
    system: INBOUND_SYSTEM,
    payload: {
      model: REQUESTED,
      messages: INBOUND_MESSAGES,
      system: INBOUND_SYSTEM,
      tools: INBOUND_TOOLS,
      max_tokens: 512,
      temperature: 0.7,
      thinking: { type: "enabled", budget_tokens: 1024 },
    },
  })
  // One-time inbound preprocessing (non-per-attempt).
  ctx.setPipelineInfo({ preprocessing: { strippedReadTagCount: 2, dedupedToolCallCount: 1 } })

  const sanitization = {
    totalBlocksRemoved: 1,
    orphanedToolUseCount: 0,
    orphanedToolResultCount: 0,
    fixedNameCount: 0,
    emptyTextBlocksRemoved: 1,
    emptyThinkingBlocksRemoved: 0,
    systemReminderRemovals: 0,
  }
  const truncation = {
    wasTruncated: true,
    removedMessageCount: 2,
    originalTokens: 9000,
    compactedTokens: 4000,
    processingTimeMs: 42,
  }

  const effective = {
    model: RESOLVED,
    resolvedModel: undefined,
    messages: INBOUND_MESSAGES,
    payload: { model: RESOLVED, system: INBOUND_SYSTEM },
    format: "openai-chat-completions" as const,
  }
  const wire = {
    model: RESOLVED,
    messages: [{ role: "user", content: "hello there [wire]" }],
    payload: { model: RESOLVED, system: INBOUND_SYSTEM },
    headers: { "x-h": "1" },
    format: "openai-chat-completions" as const,
  }

  // Attempt 0 — waits on a rate limit, sanitizes, then fails (no response).
  ctx.beginAttempt({ strategy: "primary", waitMs: 250 })
  ctx.setAttemptSanitization(sanitization)
  ctx.setAttemptEffectiveRequest(effective)
  ctx.setAttemptWireRequest(wire)
  ctx.setAttemptError({ type: "server_error", status: 500, message: "HTTP 500", raw: new HTTPError("HTTP 500", 500, "{}") })

  // Attempt 1 — retries with a truncation, succeeds.
  ctx.beginAttempt({ strategy: "server-error-retry", waitMs: 500, truncation })
  ctx.setAttemptEffectiveRequest(effective)
  ctx.setAttemptWireRequest(wire)
  ctx.complete({ success: true, model: RESOLVED, usage: { input_tokens: 100, output_tokens: 50 }, content: { role: "assistant", content: "hi" } })

  return ctx.toHistoryEntry() as unknown as HistoryEntry
}

function driveFailure(): HistoryEntry {
  const ctx = createRequestContext({ endpoint: "anthropic-messages" })
  ctx.setResolvedModel({ resolved: RESOLVED, client: REQUESTED })
  ctx.setOriginalRequest({ model: REQUESTED, messages: INBOUND_MESSAGES, stream: false, payload: { model: REQUESTED, max_tokens: 128 } })
  ctx.beginAttempt({ strategy: "primary" })
  ctx.setAttemptWireRequest({ model: RESOLVED, messages: INBOUND_MESSAGES, payload: {}, headers: {}, format: "anthropic-messages" })
  ctx.fail(RESOLVED, new HTTPError("HTTP 429 rate limited", 429, `{"error":"slow down"}`))
  return ctx.toHistoryEntry() as unknown as HistoryEntry
}

// ============================================================================
// 1. Producer populates every new field + semantic equivalence to legacy.
// ============================================================================

describe("P4c-1 producer — model{}", () => {
  test("requested = inbound alias, resolved = normalized resolved, multiplier = billing factor", () => {
    const entry = driveSuccess()
    expect(entry.model).toBeDefined()
    expect(entry.model?.requested).toBe(REQUESTED)
    expect(entry.model?.resolved).toBe(RESOLVED)
    expect(entry.model?.multiplier).toBe(MULTIPLIER)
    // Semantic equivalence to the legacy fields the new leg replaces.
    expect(entry.model?.requested).toBe(entry.inboundRequest.model)
    expect(entry.model?.resolved).toBe(entry.outboundResponse?.model)
    // NOTE: the top-level `entry.multiplier` is injected by the SINK
    // (buildHistoryActivityPatch), not by toHistoryEntry — so it is absent when the
    // producer is tested in isolation. Both derive from the SAME state.modelIndex
    // billing source, so `model.multiplier` equals the value the sink would inject.
  })
})

describe("P4c-1 producer — clientRequest structured projection (R1-W7)", () => {
  test("mirrors inboundRequest + carries body/format/method/path", () => {
    const entry = driveSuccess()
    const cr = entry.clientRequest
    expect(cr).toBeDefined()
    // Structured projections mirror the deprecated inboundRequest byte-for-byte.
    expect(cr?.model).toBe(entry.inboundRequest.model)
    expect(cr?.messages).toEqual(entry.inboundRequest.messages)
    expect(cr?.system).toEqual(entry.inboundRequest.system)
    expect(cr?.tools).toEqual(entry.inboundRequest.tools)
    expect(cr?.stream).toBe(entry.inboundRequest.stream)
    expect(cr?.max_tokens).toBe(entry.inboundRequest.max_tokens)
    expect(cr?.temperature).toBe(entry.inboundRequest.temperature)
    expect(cr?.thinking).toEqual(entry.inboundRequest.thinking)
    // Concrete values (proves the projection is real, not just self-consistent).
    expect(cr?.max_tokens).toBe(512)
    expect(cr?.temperature).toBe(0.7)
    // New captures: body (SoT) + format + method + path.
    expect(cr?.format).toBe("openai-chat-completions")
    expect(cr?.method).toBe("POST")
    expect(cr?.path).toBe("/chat/completions")
    expect((cr?.body as { max_tokens?: number }).max_tokens).toBe(512)
  })
})

describe("P4c-1 producer — _index.derived (recompute-only, three-point sync)", () => {
  test("success: mirrors final upstreamResponse.success + strategy + attemptCount, no failureReason", () => {
    const entry = driveSuccess()
    const d = entry._index?.derived
    expect(d).toBeDefined()
    expect(d?.responseSuccess).toBe(true)
    // Recompute invariant: equals the exact field the consumer reads.
    expect(d?.responseSuccess).toBe(entry.attempts?.at(-1)?.upstreamResponse?.success)
    expect(d?.currentStrategy).toBe("server-error-retry")
    expect(d?.currentStrategy).toBe(entry.currentStrategy)
    expect(d?.attemptCount).toBe(2)
    expect(d?.attemptCount).toBe(entry.attemptCount)
    expect(d?.failureReason).toBeUndefined()
  })

  test("failure: responseSuccess=false + failureReason mirrors entry.failureReason", () => {
    const entry = driveFailure()
    const d = entry._index?.derived
    expect(d?.responseSuccess).toBe(false)
    expect(d?.responseSuccess).toBe(entry.attempts?.at(-1)?.upstreamResponse?.success)
    // getErrorMessage prefixes the HTTP status; the exact string is unimportant — the
    // load-bearing invariant is that the recompute equals the entry-level projection.
    expect(d?.failureReason).toContain("rate limited")
    expect(d?.failureReason).toBe(entry.failureReason)
    expect(d?.attemptCount).toBe(1)
  })
})

describe("P4c-1 producer — attempts[].startedAt / waitMs / effectiveSource.pipeline", () => {
  test("startedAt + waitMs are output on each attempt", () => {
    const entry = driveSuccess()
    const a0 = entry.attempts?.[0]
    const a1 = entry.attempts?.[1]
    expect(typeof a0?.startedAt).toBe("number")
    expect(a0?.startedAt).toBeGreaterThan(0)
    expect(a0?.waitMs).toBe(250)
    expect(a1?.waitMs).toBe(500)
  })

  test("effectiveSource.pipeline aggregates the attempt's truncation + sanitization", () => {
    const entry = driveSuccess()
    // Attempt 0 had a sanitization pass (no truncation).
    const p0 = entry.attempts?.[0]?.effectiveSource?.pipeline
    expect(p0?.sanitization).toEqual([entry.attempts![0].sanitization!])
    expect(p0?.truncation).toBeUndefined()
    // Attempt 1 had a truncation (no sanitization).
    const p1 = entry.attempts?.[1]?.effectiveSource?.pipeline
    expect(p1?.truncation).toEqual(entry.attempts![1].truncation!)
    expect(p1?.sanitization).toBeUndefined()
  })
})

describe("P4c-1 producer — entry.preprocessing", () => {
  test("hoisted from pipelineInfo.preprocessing to the entry level", () => {
    const entry = driveSuccess()
    expect(entry.preprocessing).toEqual({ strippedReadTagCount: 2, dedupedToolCallCount: 1 })
    expect(entry.preprocessing).toEqual(entry.pipelineInfo?.preprocessing)
  })
})

// ============================================================================
// 2. Migrated consumers read the REAL populated new legs (delete-legacy technique).
// ============================================================================

describe("P4c-1 — migrated consumers read the populated new legs (not the legacy fallback)", () => {
  test("entry-view resolvers read new legs after the legacy top-level is deleted", () => {
    const entry = driveSuccess()
    // Strip the DEPRECATED legacy top-level legs the resolvers fall back to, so a
    // correct read MUST come from `_index.derived` / `attempts[final].upstreamResponse`.
    delete entry.outboundResponse
    delete entry.outboundRequest
    delete entry.effectiveRequest
    entry.attemptCount = undefined
    entry.currentStrategy = undefined

    expect(resolveResponseSuccess(entry)).toBe(true)
    expect(resolveResponseModel(entry)).toBe(RESOLVED)
    expect(resolveResponseUsage(entry)).toEqual({ input_tokens: 100, output_tokens: 50 })
    expect(resolveAttemptCount(entry)).toBe(2)
    expect(resolveCurrentStrategy(entry)).toBe("server-error-retry")
  })

  test("telemetry model dimension reads model.resolved after outboundResponse is deleted", () => {
    const entry = driveSuccess() as unknown as Parameters<(typeof TELEMETRY_DIMENSIONS)[number]["extract"]>[0]
    delete (entry as { outboundResponse?: unknown }).outboundResponse
    const modelDim = TELEMETRY_DIMENSIONS.find((d) => d.name === "model")!
    // The ctx-snapshot arg is unused by the model dimension; pass a minimal stub.
    const value = modelDim.extract(entry, { id: "x", endpoint: "openai-chat-completions", method: "POST", path: "/", state: "completed", startTime: 0, queueWaitMs: 0 })
    expect(value).toBe(RESOLVED)
  })

  test("failure entry: resolveResponseSuccess=false from _index.derived after deleting outboundResponse", () => {
    const entry = driveFailure()
    delete entry.outboundResponse
    expect(resolveResponseSuccess(entry)).toBe(false)
  })
})

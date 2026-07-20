import {
  //
  afterEach,
  beforeEach,
  expect,
  test,
} from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type {
  //
  HistoryEntryData,
  RequestState,
} from "~/lib/context/types"
import type { EndpointType } from "~/lib/history/types"
import type { Model } from "~/lib/models/client"
import type { RequestContextSnapshot } from "~/lib/observability"

import {
  //
  getLearnedLimits,
  resetAllLimitsForTesting,
  setLearnedLimitsPathForTests,
} from "~/lib/models/calibration"
import { createBus } from "~/lib/observability"
import { setStateForTests } from "~/lib/state"

import { attachCalibrationSink } from "~/lib/observability/sinks/calibration"

// A minimal Model — no `capabilities`, so `countTotalTokens` falls back to the
// default o200k_base tokenizer (see lib/models/tokenizer.ts:137).
const OPUS: Model = {
  id: "claude-opus-4.8",
  name: "Claude Opus 4.8",
  object: "model",
  vendor: "anthropic",
  version: "4.8",
  model_picker_enabled: true,
  preview: false,
  is_chat_default: false,
  is_chat_fallback: false,
}

beforeEach(() => {
  setStateForTests({ models: { object: "list", data: [OPUS] } })
  // Redirect any debounced persist to a throwaway temp file — never the real
  // $HOME learned-limits path (afterEach also cancels the timer via reset).
  const dir = mkdtempSync(join(tmpdir(), "cal-sink-"))
  setLearnedLimitsPathForTests(join(dir, "learned-limits.json"))
})

afterEach(() => {
  resetAllLimitsForTesting()
  setLearnedLimitsPathForTests(undefined)
  setStateForTests({ models: undefined })
})

function fakeCtx(): RequestContextSnapshot {
  return {
    id: "req-1",
    endpoint: "anthropic-messages",
    method: "POST",
    path: "/v1/messages",
    state: "completed" as RequestState,
    startTime: Date.now(),
    queueWaitMs: 0,
  }
}

function fakeEntry(opts: {
  format: EndpointType
  body: unknown
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}): HistoryEntryData {
  const now = Date.now()
  return {
    id: "req-1",
    endpoint: "anthropic-messages",
    startedAt: now,
    endedAt: now,
    state: "completed",
    active: false,
    lastUpdatedAt: now,
    queueWaitMs: 0,
    durationMs: 1,
    attempts: [
      {
        index: 0,
        durationMs: 1,
        upstreamRequest: { format: opts.format, body: opts.body },
        upstreamResponse: { success: true, usage: opts.usage },
      },
    ],
  }
}

test("learns from a completed anthropic-messages request", async () => {
  const bus = createBus()
  attachCalibrationSink(bus)
  bus.scope("request").publish({
    kind: "request.completed",
    ctx: fakeCtx(),
    entry: fakeEntry({
      format: "anthropic-messages",
      // ~750 tokens: clears EST_FLOOR (500) without the ~53s countTotalTokens cost
      // of a 200k-char string (multi-file batch runs were timing out on it). NB:
      // repeated "x" BPE-compresses hard, so 6000 chars ≈ 754 tokens (3000 ≈ 379).
      body: { model: "claude-opus-4.8", messages: [{ role: "user", content: "x".repeat(6000) }] },
      usage: { input_tokens: 60_000, output_tokens: 100, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 0 },
    }),
  })
  // The sink handler is async (countTotalTokens dynamically imports the tokenizer);
  // the bus tracks its returned promise so flush() awaits the learn deterministically.
  await bus.flush()
  expect(getLearnedLimits("claude-opus-4.8")?.liveSampleCount).toBe(1)
})

test("skips non-anthropic-messages format", async () => {
  const bus = createBus()
  attachCalibrationSink(bus)
  bus.scope("request").publish({
    kind: "request.completed",
    ctx: fakeCtx(),
    entry: fakeEntry({
      format: "openai-chat-completions",
      body: { model: "claude-opus-4.8", messages: [{ role: "user", content: "x".repeat(200_000) }] },
      usage: { input_tokens: 60_000, output_tokens: 100 },
    }),
  })
  await bus.flush()
  // The format gate returns before ensureModelLimits, so no entry is created.
  expect(getLearnedLimits("claude-opus-4.8")).toBeUndefined()
})

test("never throws on malformed entry (empty attempts)", async () => {
  const bus = createBus()
  attachCalibrationSink(bus)
  const entry: HistoryEntryData = {
    ...fakeEntry({ format: "anthropic-messages", body: {}, usage: { input_tokens: 1, output_tokens: 1 } }),
    attempts: [],
  }
  bus.scope("request").publish({ kind: "request.completed", ctx: fakeCtx(), entry })
  await bus.flush()
  expect(getLearnedLimits("claude-opus-4.8")).toBeUndefined()
})

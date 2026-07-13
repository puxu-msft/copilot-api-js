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
import type { Model } from "~/lib/models/client"
import type { RequestContextSnapshot } from "~/lib/observability"

import {
  //
  getLearnedLimits,
  resetAllLimitsForTesting,
  setLearnedLimitsPathForTests,
} from "~/lib/auto-truncate"
import { createBus } from "~/lib/observability"
import { setStateForTests } from "~/lib/state"

import { attachCalibrationFailureSink } from "./calibration-failure"

const MODEL = "claude-test-model"

// A minimal Model — no capabilities, so countTotalInputTokens falls back to o200k_base.
const TEST_MODEL: Model = {
  id: MODEL,
  name: MODEL,
  object: "model",
  vendor: "anthropic",
  version: "1",
  model_picker_enabled: true,
  preview: false,
  is_chat_default: false,
  is_chat_fallback: false,
} as unknown as Model

beforeEach(() => {
  setStateForTests({ models: { object: "list", data: [TEST_MODEL] } })
  const dir = mkdtempSync(join(tmpdir(), "cal-fail-sink-"))
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
    state: "failed" as RequestState,
    startTime: Date.now(),
    queueWaitMs: 0,
  }
}

function fakeFailedEntry(opts: { body: unknown; rawBody?: string; format?: string }): HistoryEntryData {
  const now = Date.now()
  return {
    id: "req-1",
    endpoint: "anthropic-messages",
    startedAt: now,
    endedAt: now,
    state: "failed",
    active: false,
    lastUpdatedAt: now,
    queueWaitMs: 0,
    durationMs: 1,
    attempts: [
      {
        index: 0,
        durationMs: 1,
        upstreamRequest: { format: opts.format ?? "anthropic-messages", body: opts.body },
        upstreamResponse: { success: false, rawBody: opts.rawBody },
      },
    ],
  } as unknown as HistoryEntryData
}

const bigBody = { model: MODEL, messages: [{ role: "user", content: "x".repeat(6000) }] }
const tokenLimit400 = JSON.stringify({ error: { message: "prompt is too long: 250000 tokens > 200000 maximum" } })

test("400 token-limit failure learns a calibration sample (isLive) into the top bucket", async () => {
  const bus = createBus()
  attachCalibrationFailureSink(bus)
  bus.scope("request").publish({
    kind: "request.failed",
    ctx: fakeCtx(),
    entry: fakeFailedEntry({ body: bigBody, rawBody: tokenLimit400 }),
    error: "prompt is too long",
    statusCode: 400,
  })
  await bus.flush()

  const learned = getLearnedLimits(MODEL)
  expect(learned).not.toBeUndefined()
  expect(learned?.liveSampleCount).toBe(1)
  // The sample is bucketed by the LOCAL estimate (not the real count); wherever it
  // lands, exactly one sample carrying the upstream real count (250000) is recorded.
  const buckets = learned?.factorModel.buckets ?? []
  expect(buckets.reduce((sum, b) => sum + b.sampleCount, 0)).toBe(1)
  expect(buckets.reduce((sum, b) => sum + b.sumReal, 0)).toBe(250000)
})

test("non-400 failure does NOT learn (negative control)", async () => {
  const bus = createBus()
  attachCalibrationFailureSink(bus)
  bus.scope("request").publish({
    kind: "request.failed",
    ctx: fakeCtx(),
    entry: fakeFailedEntry({ body: bigBody, rawBody: tokenLimit400 }),
    error: "server error",
    statusCode: 500,
  })
  await bus.flush()
  expect(getLearnedLimits(MODEL)).toBeUndefined()
})

test("400 that is NOT a token-limit error does NOT learn (negative control)", async () => {
  const bus = createBus()
  attachCalibrationFailureSink(bus)
  bus.scope("request").publish({
    kind: "request.failed",
    ctx: fakeCtx(),
    entry: fakeFailedEntry({ body: bigBody, rawBody: JSON.stringify({ error: { message: "invalid api key" } }) }),
    error: "invalid api key",
    statusCode: 400,
  })
  await bus.flush()
  expect(getLearnedLimits(MODEL)).toBeUndefined()
})

test("missing rawBody does NOT learn (negative control)", async () => {
  const bus = createBus()
  attachCalibrationFailureSink(bus)
  bus.scope("request").publish({
    kind: "request.failed",
    ctx: fakeCtx(),
    entry: fakeFailedEntry({ body: bigBody }),
    error: "boom",
    statusCode: 400,
  })
  await bus.flush()
  expect(getLearnedLimits(MODEL)).toBeUndefined()
})

test("non-anthropic-messages upstream format is skipped", async () => {
  const bus = createBus()
  attachCalibrationFailureSink(bus)
  bus.scope("request").publish({
    kind: "request.failed",
    ctx: fakeCtx(),
    entry: fakeFailedEntry({ body: bigBody, rawBody: tokenLimit400, format: "openai-chat-completions" }),
    error: "prompt is too long",
    statusCode: 400,
  })
  await bus.flush()
  expect(getLearnedLimits(MODEL)).toBeUndefined()
})

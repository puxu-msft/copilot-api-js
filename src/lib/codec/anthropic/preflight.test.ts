// Task 9: main-path pre-flight truncation via the codec `preSend` hook.
//
// The hook predicts the anthropic-caliber size (est * learned factor) and, when
// it exceeds the model's limit, pre-truncates BEFORE the first upstream send so
// the necessarily-doomed 400 round-trip is skipped. Gated by
// `state.autoTruncatePreflight` (default OFF → strict no-op).
//
// Caliber invariant (the load-bearing bug risk): `countTotalTokens` is gpt
// caliber; `calculateTokenLimit` / the predicted size are anthropic caliber. The
// target handed to `autoTruncateAnthropic` MUST be gpt caliber = floor(limit /
// factor). Test ③ pins this with an independent oracle: truncating with the
// (wrong) anthropic-caliber limit does NOT fire, while the gpt-caliber target
// does — proving the hook picked the right caliber.

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

import type { BetaProbe } from "~/lib/anthropic/pipeline"
import type { PreprocessInfo } from "~/lib/history/types"
import type { Model } from "~/lib/models/client"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { MessagesPayload } from "~/types/api/anthropic"

import {
  //
  autoTruncateAnthropic,
  countTotalTokens,
} from "~/lib/anthropic/auto-truncate"
import { calculateTokenLimit } from "~/lib/anthropic/auto-truncate/truncation"
import { createBetaProbe } from "~/lib/anthropic/pipeline"
import {
  //
  DEFAULT_AUTO_TRUNCATE_CONFIG,
  factorAt,
  learnCalibration,
  resetAllLimitsForTesting,
  setLearnedLimitsPathForTests,
} from "~/lib/auto-truncate"
import { setStateForTests } from "~/lib/state"

import { createAnthropicCodec } from "./codec"

// A model id NOT in DEFAULT_FACTOR_SEED, so ensureModelLimits seeds an EMPTY
// factor model and our single learnCalibration sample is the only anchor →
// factorAt returns exactly 2.0 for every est (single anchor).
const MODEL_ID = "test-model-preflight"
const FACTOR = 2.0

function makeModel(maxContextWindowTokens: number): Model {
  return {
    id: MODEL_ID,
    name: "Preflight Test Model",
    object: "model",
    vendor: "anthropic",
    version: "1",
    model_picker_enabled: true,
    preview: false,
    is_chat_default: false,
    is_chat_fallback: false,
    capabilities: { limits: { max_context_window_tokens: maxContextWindowTokens } },
  }
}

/** Minimal RequestEnvelope stub: preSend only reads `body`, `model`, `with({body})`. */
function makeEnv(body: MessagesPayload, model: Model): RequestEnvelope {
  const env = {
    body,
    model,
    with(patch: { body?: unknown }) {
      return makeEnv((patch.body ?? body) as MessagesPayload, model)
    },
  }
  return env as unknown as RequestEnvelope
}

function makeBody(messageCount: number): MessagesPayload {
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `Message ${i}: ${"lorem ipsum dolor sit amet consectetur ".repeat(10)}`,
  }))
  return { model: MODEL_ID, messages, stream: false } as unknown as MessagesPayload
}

const PREPROCESS_INFO: PreprocessInfo = { strippedReadTagCount: 0, dedupedToolCallCount: 0 }

function makeCodec() {
  const betaProbe: BetaProbe = createBetaProbe(undefined)
  return createAnthropicCodec({ betaProbe, preprocessInfo: PREPROCESS_INFO })
}

beforeEach(() => {
  // One calibration sample → single bucket anchor → factorAt === 2.0 everywhere.
  learnCalibration(MODEL_ID, 1000, 1000 * FACTOR, { isLive: false })
  // Debounced persist must never touch the real $HOME learned-limits path.
  const dir = mkdtempSync(join(tmpdir(), "preflight-"))
  setLearnedLimitsPathForTests(join(dir, "learned-limits.json"))
})

afterEach(() => {
  resetAllLimitsForTesting()
  setLearnedLimitsPathForTests(undefined)
  setStateForTests({ autoTruncatePreflight: false })
})

test("① default OFF (autoTruncatePreflight=false) → preSend is a strict no-op", async () => {
  setStateForTests({ autoTruncatePreflight: false })
  const body = makeBody(40)
  const model = makeModel(3000) // small limit — would truncate if enabled
  const codec = makeCodec()

  const env = makeEnv(body, model)
  const out = await codec.preSend?.(env)

  // Same envelope reference, body untouched.
  expect(out).toBe(env)
  expect((out?.body as MessagesPayload).messages.length).toBe(body.messages.length)
})

test("② predicted <= limit → preSend returns the env unchanged", async () => {
  setStateForTests({ autoTruncatePreflight: true })
  const body = makeBody(2) // tiny
  const model = makeModel(1_000_000) // huge limit
  const codec = makeCodec()

  const est = await countTotalTokens(body, model)
  const limit = calculateTokenLimit(model, DEFAULT_AUTO_TRUNCATE_CONFIG)
  // Precondition: predicted (anthropic caliber) fits.
  expect(Math.ceil(est * FACTOR)).toBeLessThanOrEqual(limit ?? 0)

  const env = makeEnv(body, model)
  const out = await codec.preSend?.(env)

  expect(out).toBe(env)
  expect((out?.body as MessagesPayload).messages.length).toBe(body.messages.length)
})

test("④ pre-flight path throws → degrades to reactive (no throw, returns env unchanged)", async () => {
  setStateForTests({ autoTruncatePreflight: true })
  // A malformed body whose `messages` is non-iterable makes `countTotalTokens`
  // throw inside the pre-flight path. spec §7: pre-flight is an OPTIMIZATION with
  // reactive truncation as the fallback, so a pre-flight error must degrade to
  // "send unchanged" (the reactive strategy still catches a real over-limit),
  // NEVER become a new hard-failure surface. Assert preSend does not reject and
  // returns the env unchanged.
  const badBody = { model: MODEL_ID, messages: null, stream: false } as unknown as MessagesPayload
  const model = makeModel(3000)
  const codec = makeCodec()

  const env = makeEnv(badBody, model)
  const out = await codec.preSend?.(env)

  expect(out).toBe(env)
  expect(out?.body).toBe(badBody)
})

test("③ predicted > limit → truncates with gpt-caliber target floor(limit/factor)", async () => {
  const codec = makeCodec()
  const body = makeBody(40)
  const est = await countTotalTokens(body, makeModel(1_000_000))
  // Choose a limit L with L/factor < est < L: correct (gpt) caliber truncates,
  // wrong (anthropic) caliber would not — see the two oracles below.
  const maxCtx = Math.round((1.4 * est) / (1 - DEFAULT_AUTO_TRUNCATE_CONFIG.safetyMarginPercent / 100))
  const model = makeModel(maxCtx)

  const factor = factorAt(MODEL_ID, est)
  expect(factor).toBeCloseTo(FACTOR, 5)
  const limit = calculateTokenLimit(model, DEFAULT_AUTO_TRUNCATE_CONFIG)
  if (limit === undefined) throw new Error("limit must be defined for this test")

  // Precondition: anthropic-caliber prediction exceeds the limit.
  expect(Math.ceil(est * factor)).toBeGreaterThan(limit)

  const targetGpt = Math.floor(limit / factor)

  // Independent oracle A: the CORRECT gpt-caliber target truncates.
  const correct = await autoTruncateAnthropic(makeBody(40), model, { checkTokenLimit: true, targetTokenLimit: targetGpt })
  expect(correct.wasTruncated).toBe(true)

  // Independent oracle B: the WRONG anthropic-caliber limit would NOT truncate
  // (limit > est in gpt caliber) — this is exactly the under-truncation bug the
  // caliber conversion prevents.
  const wrong = await autoTruncateAnthropic(makeBody(40), model, { checkTokenLimit: true, targetTokenLimit: limit })
  expect(wrong.wasTruncated).toBe(false)

  // preSend must match oracle A (gpt caliber), not the un-truncated body.
  setStateForTests({ autoTruncatePreflight: true })
  const env = makeEnv(body, model)
  const out = await codec.preSend?.(env)

  const outMessages = (out?.body as MessagesPayload).messages
  expect(outMessages.length).toBe(correct.payload.messages.length)
  expect(outMessages.length).toBeLessThan(body.messages.length)
  // A fresh envelope (with({body})) — not the same reference.
  expect(out).not.toBe(env)
})

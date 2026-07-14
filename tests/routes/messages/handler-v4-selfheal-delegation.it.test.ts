/**
 * Task 5.2 — `filterDelegatedStrategies` wiring into `buildMessagesDriverStrategies`
 * (docs/plan/2026-07-13-upstream-error-client-shaping/phase-5-selfheal-delegation.md).
 *
 * Drives the REAL production factory (`buildMessagesDriverStrategies`, mirroring
 * `tests/anthropic/forward-leg-strategies.it.test.ts`'s "unit-level directness" pattern) directly:
 * for the ENDPOINT.MESSAGES branch, `codec.parse(raw)` alone (synchronous, no driver/HTTP round-trip)
 * populates `codec.getResanitize()` + a REAL `env.ctx` (built via `withCapturingManager`, so
 * `env.ctx.recordFeature` publishes into a local array instead of the real bus) — exactly what
 * `buildMessagesDriverStrategies`'s ENDPOINT.MESSAGES branch requires. This lets the delegation wiring
 * be exercised (`.canHandle()` + the `recordFeature` side-channel) without the multi-second `waitMs`
 * delays a full retry-loop drive through `network-retry`/`server-error-retry` would incur.
 *
 * Constraint 3 (forward-translate leg untouched): the CC/Responses branch is proven UNAFFECTED by
 * `state.errorSelfhealDelegate` even for a strategy name (`token-refresh`) that exists in BOTH stacks —
 * reusing the hand-built fake env from `forward-leg-strategies.it.test.ts` (no real `.ctx`), which
 * doubles as proof the CC branch never touches `env.ctx.recordFeature` (a real call would throw on the
 * fake env's missing `.ctx`).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { RawHttpRequest } from "~/lib/pipeline/types"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { createAnthropicCodec } from "~/lib/codec/anthropic/codec"
import { withCapturingManager } from "~/lib/context/manager"
import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"
import { buildMessagesDriverStrategies } from "~/routes/messages/handler-v4"

import { mockModel } from "../../helpers/factories"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"

const MODEL = "claude-x"

const SYSTEM_REJECT_ERROR: ApiError = { type: "bad_request", status: 400, message: 'Unexpected role "system"', raw: null }
const AUTH_EXPIRED_ERROR: ApiError = { type: "auth_expired", status: 401, message: "token expired", raw: null }

/**
 * Build a REAL post-`codec.parse()` `RequestEnvelope` for the ENDPOINT.MESSAGES branch, with a real
 * (capturing, not-bus-published) `env.ctx` — so `codec.getResanitize()` is populated (required by
 * `buildMessagesDriverStrategies`'s MESSAGES branch) and `env.ctx.recordFeature` is exercisable.
 */
function makeParsedMessagesEnv(): {
  env: RequestEnvelope
  codec: ReturnType<typeof createAnthropicCodec>
  betaProbe: ReturnType<typeof createBetaProbe>
  events: ReturnType<typeof withCapturingManager<RequestEnvelope>>["events"]
} {
  const betaProbe = createBetaProbe(undefined)
  const codec = createAnthropicCodec({ betaProbe, preprocessInfo: { strippedReadTagCount: 0, dedupedToolCallCount: 0 } })
  const raw = {
    body: { model: MODEL, max_tokens: 128, messages: [{ role: "user", content: "hi" }], stream: false },
    headers: new Headers(),
    path: "/v1/messages",
    method: "POST",
  } as unknown as RawHttpRequest
  const { result: env, events } = withCapturingManager(() => codec.parse(raw))
  return { env, codec, betaProbe, events }
}

/** A hand-built fake env for the CC forward-translate leg (no real `.ctx`) — mirrors T7.2's pattern. */
function ccLegEnv(leg: (typeof ENDPOINT)["CHAT_COMPLETIONS"] | (typeof ENDPOINT)["RESPONSES"]): RequestEnvelope {
  return { targetEndpoint: leg, body: { model: MODEL, messages: [] }, model: { id: MODEL } } as unknown as RequestEnvelope
}

describe("buildMessagesDriverStrategies — D-class self-heal delegation wiring (ENDPOINT.MESSAGES only)", () => {
  useIsolatedRuntime()

  const seed = () =>
    setModels({
      object: "list",
      data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.RESPONSES] })],
    })

  test("errorSelfhealDelegate={} (default/omitted) → system-reject-retry.canHandle unaffected (regression lock)", () => {
    seed()
    setStateForTests({ errorShapingEnabled: true, errorSelfhealDelegate: {} })
    const { env, codec, betaProbe } = makeParsedMessagesEnv()
    const stack = buildMessagesDriverStrategies(env, { codec, betaProbe })
    const strat = stack.find((s) => s.name === "system-reject-retry")
    expect(strat?.canHandle(SYSTEM_REJECT_ERROR)).toBe(true)
  })

  test('errorSelfhealDelegate={"system-reject-retry":"delegate"} → canHandle forced false + recordFeature fires exactly once', () => {
    seed()
    setStateForTests({ errorShapingEnabled: true, errorSelfhealDelegate: { "system-reject-retry": "delegate" } })
    const { env, codec, betaProbe, events } = makeParsedMessagesEnv()
    const stack = buildMessagesDriverStrategies(env, { codec, betaProbe })
    const strat = stack.find((s) => s.name === "system-reject-retry")
    expect(strat?.canHandle(SYSTEM_REJECT_ERROR)).toBe(false)

    const featureEvents = events.filter(
      (e) => e.kind === "request.feature_applied" && (e as { feature?: string }).feature === "error-shaping-selfheal-delegated",
    )
    expect(featureEvents).toHaveLength(1)
    expect((featureEvents[0] as { detail?: unknown }).detail).toEqual({ strategyName: "system-reject-retry" })
  })

  test("errorShapingEnabled=false → delegation entirely disabled (falls back to the full undelegated stack, current behavior)", () => {
    seed()
    setStateForTests({ errorShapingEnabled: false, errorSelfhealDelegate: { "system-reject-retry": "delegate" } })
    const { env, codec, betaProbe } = makeParsedMessagesEnv()
    const stack = buildMessagesDriverStrategies(env, { codec, betaProbe })
    const strat = stack.find((s) => s.name === "system-reject-retry")
    expect(strat?.canHandle(SYSTEM_REJECT_ERROR)).toBe(true)
  })

  test("a delegate key matching no real strategy .name → silently ignored, other strategies unaffected, no throw", () => {
    seed()
    setStateForTests({ errorShapingEnabled: true, errorSelfhealDelegate: { "not-a-real-strategy": "delegate" } })
    const { env, codec, betaProbe } = makeParsedMessagesEnv()
    let stack: ReturnType<typeof buildMessagesDriverStrategies> = []
    expect(() => {
      stack = buildMessagesDriverStrategies(env, { codec, betaProbe })
    }).not.toThrow()
    const strat = stack.find((s) => s.name === "system-reject-retry")
    expect(strat?.canHandle(SYSTEM_REJECT_ERROR)).toBe(true)
  })
})

describe("buildMessagesDriverStrategies — constraint 3: the forward-translate leg is completely unaffected", () => {
  useIsolatedRuntime()

  test("@cc leg: token-refresh.canHandle is unaffected by errorSelfhealDelegate (shared strategy name, different branch)", () => {
    setStateForTests({ errorShapingEnabled: true, errorSelfhealDelegate: { "token-refresh": "delegate" } })
    const betaProbe = createBetaProbe(undefined)
    const codec = createAnthropicCodec({ betaProbe, preprocessInfo: { strippedReadTagCount: 0, dedupedToolCallCount: 0 } })
    // No real `.ctx` on this hand-built env — if the CC branch touched `env.ctx.recordFeature`, this
    // would throw, so a clean pass also proves the CC branch is untouched by the D-class wiring.
    const stack = buildMessagesDriverStrategies(ccLegEnv(ENDPOINT.CHAT_COMPLETIONS), { codec, betaProbe })
    const strat = stack.find((s) => s.name === "token-refresh")
    expect(strat?.canHandle(AUTH_EXPIRED_ERROR)).toBe(true)
  })

  test("@responses leg: token-refresh.canHandle is unaffected by errorSelfhealDelegate", () => {
    setStateForTests({ errorShapingEnabled: true, errorSelfhealDelegate: { "token-refresh": "delegate" } })
    const betaProbe = createBetaProbe(undefined)
    const codec = createAnthropicCodec({ betaProbe, preprocessInfo: { strippedReadTagCount: 0, dedupedToolCallCount: 0 } })
    const stack = buildMessagesDriverStrategies(ccLegEnv(ENDPOINT.RESPONSES), { codec, betaProbe })
    const strat = stack.find((s) => s.name === "token-refresh")
    expect(strat?.canHandle(AUTH_EXPIRED_ERROR)).toBe(true)
  })
})

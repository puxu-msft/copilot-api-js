/**
 * Task 5.2 — `filterDelegatedStrategies` wiring into the `/v1/messages` DIRECT-leg strategy assembly
 * (docs/plan/2026-07-13-upstream-error-client-shaping/phase-5-selfheal-delegation.md).
 *
 * RECONCILE (2026-07-13, landed CellAssembly): master collapsed the handler's
 * `buildMessagesDriverStrategies` factory into `OUTBOUND_LEGS[ENDPOINT.MESSAGES].buildLegStrategies`
 * (src/lib/codec/anthropic/anthropic-cell.ts), composed via `resolveCellAssembly(cf, te).buildStrategies`.
 * The delegation wrap moved with it — onto the DIRECT anthropic-client branch (the non-reverse branch of
 * `buildLegStrategies`). This test now drives that REAL seam instead of the deleted handler factory.
 *
 * Drives the REAL production seam directly (mirroring `tests/anthropic/forward-leg-strategies.it.test.ts`'s
 * "assembly-level directness" pattern): for the DIRECT `/v1/messages` cell, `codec.parse(raw)` alone
 * (synchronous, no driver/HTTP round-trip) populates `env.requestState` (betaProbe/truncateBaseline/
 * resanitize — the supply `buildLegStrategies` reads) + a REAL `env.ctx` (built via `withCapturingManager`,
 * so `env.ctx.recordFeature` publishes into a local array instead of the real bus). `resolveCellAssembly
 * ("anthropic", ENDPOINT.MESSAGES).buildStrategies(env)` then exercises the delegation wrap (`.canHandle()`
 * + the `recordFeature` side-channel) without the multi-second `waitMs` delays a full retry-loop drive
 * through `network-retry`/`server-error-retry` would incur.
 *
 * Constraint 3 (forward-translate legs untouched): the anthropic→CC/Responses FORWARD cells are a DIFFERENT
 * leg entirely (chatCompletionsLeg/responsesLeg via cc-family-strategies) — proven UNAFFECTED by
 * `state.errorSelfhealDelegate` even for a strategy name (`token-refresh`) that exists in BOTH stacks. The
 * REVERSE `@messages` cells (cc/responses/gemini client → Anthropic wire) share `buildLegStrategies` with the
 * direct leg but are STRUCTURALLY untouched: their `if (isReverse(env)) return ...` returns before the
 * delegation wrap (only `clientFormat === "anthropic"` reaches it).
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
import { setModels } from "~/lib/models/cache"
import { ENDPOINT } from "~/lib/models/endpoint"
import { resolveCellAssembly } from "~/lib/pipeline/cell-assembly"
import { setStateForTests } from "~/lib/state"

import { mockModel } from "../../helpers/factories"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"

const MODEL = "claude-x"

const SYSTEM_REJECT_ERROR: ApiError = { type: "bad_request", status: 400, message: 'Unexpected role "system"', raw: null }
const AUTH_EXPIRED_ERROR: ApiError = { type: "auth_expired", status: 401, message: "token expired", raw: null }

/** The DIRECT `/v1/messages` cell strategy assembly (my Phase 5 delegation branch lives here). */
const directMessagesStrategies = (env: RequestEnvelope) => resolveCellAssembly("anthropic", ENDPOINT.MESSAGES).buildStrategies(env)

/**
 * Build a REAL post-`codec.parse()` DIRECT `/v1/messages` `RequestEnvelope`, with a real (capturing,
 * not-bus-published) `env.ctx` — so `env.requestState` is populated (the supply `buildLegStrategies` reads)
 * and `env.ctx.recordFeature` is exercisable.
 */
function makeParsedMessagesEnv(): {
  env: RequestEnvelope
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
  return { env, events }
}

/**
 * A hand-built fake env for a FORWARD translate leg (anthropic client → CC/Responses OUTBOUND, no real
 * `.ctx`). clientFormat "anthropic" + a CC/Responses targetEndpoint selects the cc-family FORWARD branch
 * (reads env.body, no requestState needed) — mirrors `forward-leg-strategies.it.test.ts`'s ccLegEnv.
 */
function forwardLegEnv(leg: (typeof ENDPOINT)["CHAT_COMPLETIONS"] | (typeof ENDPOINT)["RESPONSES"]): RequestEnvelope {
  return {
    clientFormat: "anthropic",
    targetEndpoint: leg,
    body: { model: MODEL, messages: [] },
    model: { id: MODEL },
    requestState: {},
  } as unknown as RequestEnvelope
}

describe("direct /v1/messages assembly — D-class self-heal delegation wiring (anthropic-client leg only)", () => {
  useIsolatedRuntime()

  const seed = () =>
    setModels({
      object: "list",
      data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES, ENDPOINT.CHAT_COMPLETIONS, ENDPOINT.RESPONSES] })],
    })

  test("errorSelfhealDelegate={} (default/omitted) → system-reject-retry.canHandle unaffected (regression lock)", () => {
    seed()
    setStateForTests({ errorShapingEnabled: true, errorSelfhealDelegate: {} })
    const { env } = makeParsedMessagesEnv()
    const stack = directMessagesStrategies(env)
    const strat = stack.find((s) => s.name === "system-reject-retry")
    expect(strat?.canHandle(SYSTEM_REJECT_ERROR)).toBe(true)
  })

  test('errorSelfhealDelegate={"system-reject-retry":"delegate"} → canHandle forced false + recordFeature fires exactly once', () => {
    seed()
    setStateForTests({ errorShapingEnabled: true, errorSelfhealDelegate: { "system-reject-retry": "delegate" } })
    const { env, events } = makeParsedMessagesEnv()
    const stack = directMessagesStrategies(env)
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
    const { env } = makeParsedMessagesEnv()
    const stack = directMessagesStrategies(env)
    const strat = stack.find((s) => s.name === "system-reject-retry")
    expect(strat?.canHandle(SYSTEM_REJECT_ERROR)).toBe(true)
  })

  test("a delegate key matching no real strategy .name → silently ignored, other strategies unaffected, no throw", () => {
    seed()
    setStateForTests({ errorShapingEnabled: true, errorSelfhealDelegate: { "not-a-real-strategy": "delegate" } })
    const { env } = makeParsedMessagesEnv()
    let stack: ReturnType<typeof directMessagesStrategies> = []
    expect(() => {
      stack = directMessagesStrategies(env)
    }).not.toThrow()
    const strat = stack.find((s) => s.name === "system-reject-retry")
    expect(strat?.canHandle(SYSTEM_REJECT_ERROR)).toBe(true)
  })
})

describe("constraint 3: the anthropic→CC/Responses FORWARD translate legs are completely unaffected", () => {
  useIsolatedRuntime()

  test("@cc forward leg: token-refresh.canHandle is unaffected by errorSelfhealDelegate (shared strategy name, different leg)", () => {
    setStateForTests({ errorShapingEnabled: true, errorSelfhealDelegate: { "token-refresh": "delegate" } })
    // No real `.ctx` on this hand-built env — if the FORWARD leg touched `env.ctx.recordFeature`, this would
    // throw, so a clean pass also proves the forward leg is untouched by the D-class wiring.
    const stack = resolveCellAssembly("anthropic", ENDPOINT.CHAT_COMPLETIONS).buildStrategies(forwardLegEnv(ENDPOINT.CHAT_COMPLETIONS))
    const strat = stack.find((s) => s.name === "token-refresh")
    expect(strat?.canHandle(AUTH_EXPIRED_ERROR)).toBe(true)
  })

  test("@responses forward leg: token-refresh.canHandle is unaffected by errorSelfhealDelegate", () => {
    setStateForTests({ errorShapingEnabled: true, errorSelfhealDelegate: { "token-refresh": "delegate" } })
    const stack = resolveCellAssembly("anthropic", ENDPOINT.RESPONSES).buildStrategies(forwardLegEnv(ENDPOINT.RESPONSES))
    const strat = stack.find((s) => s.name === "token-refresh")
    expect(strat?.canHandle(AUTH_EXPIRED_ERROR)).toBe(true)
  })
})

/**
 * Task 1 (Commit 1) — golden pre-capture of the 6 cell retry-strategy assembly orders (pre-refactor lock).
 *
 * docs/plan/2026-07-21-retry-strategy-registry.md Task 1: locks the CURRENT (pre-registry) `strategy.name[]`
 * order produced by each cell's assembly entry point, as the byte-equivalence oracle Task 3's "golden 逐字节
 * 仍过" gate re-runs after the declarative-registry refactor lands. Six cells:
 *
 *   1. anthropic direct `/v1/messages`      — `buildAnthropicStrategies` (16)
 *   2. openai-cc direct `/chat/completions` — `buildOpenAiCcStrategies` (3)
 *   3. openai-responses direct `/responses` — `buildOpenAiResponsesStrategies` (3, the HTTP construction
 *      path — never through `src/routes/responses/ws.ts`'s zero-arg WS driver factory, which the plan notes
 *      does not fit a minimal-deps unit-level drive)
 *   4-6. the 3 REVERSE `@messages` legs (openai-cc / openai-responses / gemini client → Anthropic wire) —
 *      driven through the REAL production seam `anthropicMessagesLeg.buildLegStrategies(spec, env)`
 *      (src/lib/codec/anthropic/anthropic-cell.ts:144), each expected to yield the SAME 16 (the reverse
 *      branch delegates straight to `buildAnthropicStrategies`, RFC §3.3 — the anthropic stack applies by
 *      `targetEndpoint === ENDPOINT.MESSAGES`, not `clientFormat === "anthropic"`).
 *
 * The reverse envs are hand-built minimal fakes (mirrors `ccLegEnv`/`forwardLegEnv` in
 * `tests/anthropic/forward-leg-strategies.it.test.ts` / `tests/routes/messages/handler-v4-selfheal-
 * delegation.it.test.ts`): the reverse branch of `buildLegStrategies` never touches `env.ctx`, only
 * `env.requestState.{reverseMapperHolder,betaProbe}` + `env.body` — so no real codec/driver/runtime dance is
 * needed to exercise it here.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RetrySemanticsSpec } from "~/lib/pipeline/cell-assembly"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { SanitizeResult } from "~/lib/request/retry-types"
import type { MessagesPayload } from "~/types/api/anthropic"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { anthropicMessagesLeg } from "~/lib/codec/anthropic/anthropic-cell"
import { buildAnthropicStrategies } from "~/lib/codec/anthropic/strategies"
import { createReverseAnthropicMapperHolder } from "~/lib/codec/openai-cc/reverse-anthropic-rewrite"
import { buildOpenAiCcStrategies } from "~/lib/codec/openai-cc/strategies"
import { buildOpenAiResponsesStrategies } from "~/lib/codec/openai-responses/strategies"
import { ENDPOINT } from "~/lib/models/endpoint"

/**
 * The frozen 16-name Anthropic-stack order (RFC §12.9 / `tests/anthropic/anthropic-codec.unit.test.ts`'s
 * existing direct-leg assertion) — shared by the direct `/v1/messages` leg AND all 3 reverse `@messages`
 * legs (the reverse branch of `buildLegStrategies` delegates to the SAME `buildAnthropicStrategies`).
 */
const ANTHROPIC_16_NAMES = [
  "network-retry",
  "server-error-retry",
  "token-refresh",
  "effort-learning",
  "tool-field-rejection-retry",
  "body-field-rejection-retry",
  "cache-control-subfield-rejection-retry",
  "legacy-thinking-retry",
  "adaptive-thinking-rejection-retry",
  "poisoned-thinking-retry",
  "unsupported-beta-retry",
  "server-tool-rejection-retry",
  "structured-outputs-rejection-retry",
  "system-reject-retry",
  "web-search-not-found-retry",
  "deferred-tool-retry",
]

/** The shared 3-name stack (network → server-error → token-refresh) both CC and Responses direct legs yield
 *  since master removed auto-truncate (2026-07-13) — every CC-family leg's strategy STACK is now identical. */
const SHARED_3_NAMES = ["network-retry", "server-error-retry", "token-refresh"]

const stubResanitize = (p: MessagesPayload): SanitizeResult<MessagesPayload> => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0 })
const anthropicBaseline = { model: "claude-sonnet-4", messages: [], max_tokens: 100 } as unknown as MessagesPayload
const ccBaseline = { model: "gpt-4", messages: [] } as unknown as ChatCompletionsPayload
const responsesBaseline = { model: "gpt-5", input: [] } as unknown as ResponsesPayload

describe("retry-strategy assembly golden (pre-refactor lock, Task 1 / Commit 1)", () => {
  test("1. anthropic direct @messages → 16 策略顺序 (buildAnthropicStrategies)", () => {
    const names = buildAnthropicStrategies({
      originalPayload: anthropicBaseline,
      resanitize: stubResanitize,
      model: undefined,
      maxRetries: 5,
      betaProbe: createBetaProbe(undefined),
    }).map((s) => s.name)
    expect(names).toEqual(ANTHROPIC_16_NAMES)
  })

  test("2. openai-cc direct → 3 策略顺序 (buildOpenAiCcStrategies)", () => {
    const names = buildOpenAiCcStrategies({
      originalPayload: ccBaseline,
      model: undefined,
      maxRetries: 5,
      label: "Completions",
    }).map((s) => s.name)
    expect(names).toEqual(SHARED_3_NAMES)
  })

  test("3. openai-responses direct → 3 策略顺序 (buildOpenAiResponsesStrategies, HTTP 构造路径)", () => {
    const names = buildOpenAiResponsesStrategies({
      originalPayload: responsesBaseline,
      model: undefined,
      maxRetries: 1,
    }).map((s) => s.name)
    expect(names).toEqual(SHARED_3_NAMES)
  })

  describe("4-6. reverse @messages legs (via anthropicMessagesLeg.buildLegStrategies) → 各 16 策略顺序", () => {
    /** A minimal reverse `@messages` env (mirrors `ccLegEnv`/`forwardLegEnv`) — no real `.ctx` needed: the
     *  reverse branch of `buildLegStrategies` reads only `env.body` + `env.requestState`. */
    function reverseEnv(clientFormat: "gemini" | "openai-cc" | "openai-responses"): RequestEnvelope {
      return {
        clientFormat,
        targetEndpoint: ENDPOINT.MESSAGES,
        body: anthropicBaseline,
        model: { id: "claude-sonnet-4" },
        requestState: {
          reverseMapperHolder: createReverseAnthropicMapperHolder("claude-sonnet-4"),
          betaProbe: createBetaProbe(undefined),
        },
      } as unknown as RequestEnvelope
    }

    const spec: RetrySemanticsSpec = { maxRetries: 5, label: "test" }

    test("4. openai-cc → messages reverse leg → 16 策略顺序", () => {
      const names = anthropicMessagesLeg.buildLegStrategies(spec, reverseEnv("openai-cc")).map((s) => s.name)
      expect(names).toEqual(ANTHROPIC_16_NAMES)
    })

    test("5. openai-responses → messages reverse leg → 16 策略顺序 (HTTP 构造路径，非 WS)", () => {
      const names = anthropicMessagesLeg.buildLegStrategies(spec, reverseEnv("openai-responses")).map((s) => s.name)
      expect(names).toEqual(ANTHROPIC_16_NAMES)
    })

    test("6. gemini → messages reverse leg → 16 策略顺序", () => {
      const names = anthropicMessagesLeg.buildLegStrategies(spec, reverseEnv("gemini")).map((s) => s.name)
      expect(names).toEqual(ANTHROPIC_16_NAMES)
    })
  })
})

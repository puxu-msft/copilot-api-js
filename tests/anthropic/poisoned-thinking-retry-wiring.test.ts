/**
 * L2 poisoned-thinking retry — WIRING test (Task 7). Proves the strategy is
 * actually registered on BOTH pipeline paths (Task 6 built it but wired it
 * nowhere), driving the real "thinking ... cannot be modified" 400 through the
 * assembled strategy list end-to-end:
 *
 *   1. v4 active path — `buildAnthropicStrategies` (codec/anthropic/strategies).
 *      The entry MUST be present, `canHandle` the real 400, and `handle` return
 *      the NATIVE env-action shape (`{ kind: "retry", env, learning }`, reading
 *      `env.body` + stripping every thinking block) — i.e. UNWRAPPED, not the
 *      `adaptLegacyStrategy` payload-shape wrapper (which would drop the `env.ctx`
 *      L3 later needs).
 *   2. legacy path — `buildAnthropicStrategies` (anthropic/pipeline, the
 *      web_search double-hop). The twin MUST be present and return the LEGACY
 *      `{ action: "retry", payload, meta }` shape.
 *
 * Both assert the strip-all remediation ran (thinking removed, count in meta), so
 * a registration that wired the wrong instance (adapted vs native, or omitted the
 * matcher) fails loudly.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { SanitizeResult } from "~/lib/request/pipeline"
import type {
  //
  MessageParam,
  MessagesPayload,
} from "~/types/api/anthropic"

import {
  //
  buildAnthropicStrategies as buildLegacyStrategies,
  createBetaProbe,
} from "~/lib/anthropic/pipeline"
import { buildAnthropicStrategies as buildV4Strategies } from "~/lib/codec/anthropic/strategies"
import {
  //
  classifyError,
  HTTPError,
} from "~/lib/error"
import { setStateForTests } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

// The real GHC rejection body — the phrase lives in the JSON `error.message`, not
// the terse classified `message`, so `canHandle` must parse `raw.responseText`.
const POISON_BODY =
  '{"error":{"message":"messages.3.content.34: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response."}}'

function realRejection() {
  return classifyError(new HTTPError("400 Bad Request", 400, POISON_BODY))
}

/** One poisoned assistant turn (thinking + text) — strip-all must drop the thinking block. */
function poisonedMessages(): Array<MessageParam> {
  return [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "leaked", signature: "sig" },
        { type: "text", text: "hi" },
      ],
    },
  ] as unknown as Array<MessageParam>
}

const baseline = { model: "claude-opus-4.8", messages: [], max_tokens: 100 } as unknown as MessagesPayload
const stubResanitize = (p: MessagesPayload): SanitizeResult<MessagesPayload> => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0 })

/** Minimal real envelope (mirrors tests/pipeline/legacy-strategy-adapter's makeEnv). */
function makeEnv(body: unknown): RequestEnvelope {
  return {
    body,
    prepareHints: {},
    with(patch: Partial<RequestEnvelope>): RequestEnvelope {
      return { ...this, ...patch } as RequestEnvelope
    },
  } as unknown as RequestEnvelope
}

function hasThinking(payload: MessagesPayload): boolean {
  return payload.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "thinking" || b.type === "redacted_thinking"))
}

describe("poisoned-thinking-retry wiring — v4 active path", () => {
  autoRestoreState()

  function buildV4() {
    return buildV4Strategies({
      originalPayload: baseline,
      resanitize: stubResanitize,
      model: undefined,
      maxRetries: 5,
      betaProbe: createBetaProbe(undefined),
    })
  }

  test("registered in the v4 list right after legacy-thinking-retry", () => {
    setStateForTests({ stripThinkingOnReject: true })
    const names = buildV4().map((s) => s.name)
    expect(names).toContain("poisoned-thinking-retry")
    // ordered among the 400-class handlers, immediately after legacy-thinking-retry
    expect(names.indexOf("poisoned-thinking-retry")).toBe(names.indexOf("legacy-thinking-retry") + 1)
  })

  test("canHandle fires on the real 400, handle returns the NATIVE env-action (strips thinking)", async () => {
    setStateForTests({ stripThinkingOnReject: true })
    const strat = buildV4().find((s) => s.name === "poisoned-thinking-retry")
    expect(strat).toBeDefined()
    if (!strat) return
    expect(strat.canHandle(realRejection())).toBe(true)

    const action = await strat.handle(realRejection(), makeEnv({ model: "claude-opus-4.8", messages: poisonedMessages() }))
    // Native env shape: { kind: "retry", env, learning } — NOT the legacy { action } shape.
    expect(action.kind).toBe("retry")
    if (action.kind !== "retry") return
    expect(hasThinking(action.env.body as MessagesPayload)).toBe(false)
    expect(action.meta?.strippedThinkingOnReject).toBe(1)
    expect(action.learning).toBe(true)
  })
})

describe("poisoned-thinking-retry wiring — legacy web_search path", () => {
  autoRestoreState()

  function buildLegacy() {
    return buildLegacyStrategies({ betaProbe: createBetaProbe(undefined), resanitize: stubResanitize })
  }

  test("registered in the legacy list right after legacy-thinking-retry", () => {
    setStateForTests({ stripThinkingOnReject: true })
    const names = buildLegacy().map((s) => s.name)
    expect(names).toContain("poisoned-thinking-retry")
    expect(names.indexOf("poisoned-thinking-retry")).toBe(names.indexOf("legacy-thinking-retry") + 1)
  })

  test("canHandle fires on the real 400, handle returns the LEGACY {action,payload,meta} shape (strips thinking)", async () => {
    setStateForTests({ stripThinkingOnReject: true })
    const strat = buildLegacy().find((s) => s.name === "poisoned-thinking-retry")
    expect(strat).toBeDefined()
    if (!strat) return
    expect(strat.canHandle(realRejection())).toBe(true)

    const payload = { model: "claude-opus-4.8", messages: poisonedMessages() } as unknown as MessagesPayload
    const action = await strat.handle(realRejection(), payload, { attempt: 0, originalPayload: baseline, model: undefined, maxRetries: 5 })
    // Legacy shape: { action: "retry", payload, meta } — NOT the env { kind } shape.
    expect(action.action).toBe("retry")
    if (action.action !== "retry") return
    expect(hasThinking(action.payload)).toBe(false)
    expect(action.meta?.strippedThinkingOnReject).toBe(1)
    // Reliability symmetry with the native path: the corrective strip-all retry
    // draws from the learning budget so it can't be starved under a retry pileup.
    expect(action.learning).toBe(true)
  })
})

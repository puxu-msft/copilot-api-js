/**
 * Task 5.1/5.2 (docs/plan/2026-07-12-upstream-hook-middleware/plan-5-integration-closeout.md)
 * — shared scaffolding for the "does the hook mount point really drive PRODUCTION machinery"
 * integration tests. Unlike `driver-test-helpers.ts` (mock codec/transport — proves the driver's
 * OWN orchestration), this file wires the REAL Anthropic codec + REAL retry-strategy stack
 * (`buildAnthropicStrategies`, the exact production factory `routes/messages/handler-v4.ts` uses),
 * so a hook-injected 400 is handled by the ACTUAL `tool-field-rejection-retry` strategy instance —
 * not a hand-rolled stand-in — and the resulting attempts are read back from the REAL persisted
 * history store (`~/lib/history`'s `getEntry`), not a recording mock ctx. Only `transport` is
 * faked (no real network) — everything else (codec, strategies, driver, hook loader, ctx, history
 * sink) is production code, mirroring `handler-v4.ts`'s `runMessagesDriver` wiring.
 */

import type {
  //
  RawHttpRequest,
  Transport,
  UpstreamStream,
} from "~/lib/pipeline/types"
import type { MessagesPayload } from "~/types/api/anthropic"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { createAnthropicCodec } from "~/lib/codec/anthropic/codec"
import { buildAnthropicStrategies } from "~/lib/codec/anthropic/strategies"
import { setModels } from "~/lib/models/cache"
import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  createPipelineDriver,
  type PipelineDriverWithNonStreaming,
} from "~/lib/pipeline/driver"
import { state } from "~/lib/state"

import { mockModel } from "../../helpers/factories"

/** Seed `state.modelIndex` with one Anthropic-vendor model supporting the direct `/v1/messages` leg. */
export function seedAnthropicModel(id = "claude-x"): void {
  setModels({ object: "list", data: [mockModel(id, { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES] })] })
}

/** Build a minimal but wire-valid Anthropic request body carrying one custom tool (realistic
 *  shape for a tool-field-rejection scenario — content doesn't matter to the mock error injection,
 *  but a real body keeps the test honest about what a real client sends). */
export function anthropicToolBody(model: string): MessagesPayload {
  return {
    model,
    max_tokens: 128,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "custom", name: "get_weather", input_schema: { type: "object", properties: {} } }],
  } as unknown as MessagesPayload
}

export function anthropicRawRequest(body: MessagesPayload): RawHttpRequest {
  return { body, headers: new Headers({ "content-length": "1" }), method: "POST", path: ENDPOINT.MESSAGES } as unknown as RawHttpRequest
}

/**
 * Build a driver wired EXACTLY like `runMessagesDriver` (real codec + real
 * `buildAnthropicStrategies`), with a caller-supplied fake `transport` standing in for the real
 * upstream HTTP client. Returns the driver + a `sendCount` accessor so a test can assert the
 * transport was (or wasn't) actually invoked — independent of anything the hook itself reports.
 */
export function makeRealAnthropicDriver(transport: Transport): PipelineDriverWithNonStreaming {
  const betaProbe = createBetaProbe(undefined)
  const codec = createAnthropicCodec({ betaProbe, preprocessInfo: { strippedReadTagCount: 0, dedupedToolCallCount: 0 } })
  return createPipelineDriver({
    codec,
    transport,
    requestRewrites: codec.getRequestRewrites(),
    strategies: (env) => {
      const resanitize = codec.getResanitize()
      if (!resanitize) throw new Error("resanitize chain unavailable — codec.parse did not run")
      return buildAnthropicStrategies({
        originalPayload: codec.getTruncateBaseline() ?? (env.body as MessagesPayload),
        resanitize,
        model: env.model as never,
        maxRetries: state.maxReactiveRetries,
        betaProbe,
      })
    },
    maxRetries: state.maxReactiveRetries,
    maxLearningRetries: 32,
  })
}

/** Counting fake transport: records every real `.send()` invocation (never touches the network). */
export function makeCountingTransport(respond: () => Promise<UpstreamStream> | UpstreamStream): { transport: Transport; sendCount: () => number } {
  let count = 0
  return {
    transport: {
      send: async (..._args) => {
        count++
        return respond()
      },
    },
    sendCount: () => count,
  }
}

export async function collectFrames<T>(iter: AsyncIterable<T>): Promise<Array<T>> {
  const out: Array<T> = []
  for await (const item of iter) out.push(item)
  return out
}

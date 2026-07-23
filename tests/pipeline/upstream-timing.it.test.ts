/**
 * Task 1.1 — driver loop-top upstream timing capture (spec 2026-07-14 §3.2/§4).
 * 驱动 `runResponse` 用真实 ctx + mock upstream 帧，断言当前 attempt 的上游 3 刻
 * （message_start / first_token / last_token）被记录且有序；含 M-E 修复的 openai
 * data-only 臂（无 event 行，靠 JSON.parse）。
 */
import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { DriverDeps } from "~/lib/pipeline/driver"
import type {
  //
  ClientFormat,
  RequestEnvelope,
} from "~/lib/pipeline/envelope"
import type {
  //
  ClientFrame,
  FormatCodec,
  PreparedRequest,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

import { createRequestContext } from "~/lib/context/request"
import { createPipelineDriver } from "~/lib/pipeline/driver"

async function* frames(items: Array<UpstreamFrame>): AsyncIterable<UpstreamFrame> {
  for (const it of items) yield it
}
function upstream(items: Array<UpstreamFrame>): UpstreamStream {
  return { frames: frames(items), headers: new Headers() }
}

function makeCodec(format: ClientFormat): FormatCodec {
  return {
    format,
    parse: () => {
      throw new Error("parse not used")
    },
    translateOut: (env) => env,
    prepareWire: () => ({ url: "u", headers: new Headers(), body: {}, stream: true }) as PreparedRequest,
    renderResponse: (frame) => frame, // identity
    renderResponseNonStreaming: (u) => u,
    formatError: () => ({ event: "error", data: "{}" }) as ClientFrame,
    createResponseAccumulator: () => ({ model: "", inputTokens: 0, outputTokens: 0, rawContent: "" }),
  }
}

function makeEnv(clientFormat: ClientFormat, targetEndpoint: string): RequestEnvelope {
  const ctx = createRequestContext({ endpoint: "anthropic-messages" })
  ctx.beginAttempt({})
  return {
    clientFormat,
    targetEndpoint,
    model: {},
    stream: true,
    body: {},
    view: {},
    prepareHints: {},
    ctx,
    with(patch: Partial<RequestEnvelope>): RequestEnvelope {
      return { ...this, ...patch } as unknown as RequestEnvelope
    },
  } as unknown as RequestEnvelope
}

function driverFor(format: ClientFormat) {
  const deps: DriverDeps = {
    codec: makeCodec(format),
    transport: { send: () => Promise.reject(new Error("unused")) },
    strategies: [],
    maxRetries: 0,
    maxLearningRetries: 0,
  }
  return createPipelineDriver(deps)
}

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) {
    /* consume */
  }
}

describe("driver loop-top upstream timing capture", () => {
  test("anthropic upstream: message_start <= first_token <= last_token on current attempt", async () => {
    const env = makeEnv("anthropic", "/v1/messages")
    const driver = driverFor("anthropic")
    await drain(
      driver.runResponse(
        upstream([
          { event: "message_start", data: '{"type":"message_start"}' },
          { event: "content_block_start", data: '{"type":"content_block_start"}' },
          { event: "content_block_delta", data: '{"type":"content_block_delta"}' },
          { event: "content_block_delta", data: '{"type":"content_block_delta"}' },
          { event: "message_stop", data: '{"type":"message_stop"}' },
        ]),
        env,
      ),
    )
    const a = env.ctx.currentAttempt!
    expect(a.upstreamMessageStartAt).toBeGreaterThan(0)
    expect(a.upstreamFirstTokenAt).toBeGreaterThanOrEqual(a.upstreamMessageStartAt!)
    expect(a.upstreamLastTokenAt).toBeGreaterThanOrEqual(a.upstreamFirstTokenAt!)
    expect(env.ctx.modelOperationSnapshot.dispatches[0]?.timing).toEqual({
      upstreamMessageStartAt: a.upstreamMessageStartAt,
      upstreamFirstTokenAt: a.upstreamFirstTokenAt,
      upstreamLastTokenAt: a.upstreamLastTokenAt,
    })
  })

  test("openai upstream (data-only chunks, M-E): first/last token captured, no message_start", async () => {
    const env = makeEnv("openai-cc", "/chat/completions")
    const driver = driverFor("openai-cc")
    await drain(
      driver.runResponse(
        upstream([
          { data: '{"choices":[{"delta":{"role":"assistant"}}]}' }, // role frame — NOT content
          { data: '{"choices":[{"delta":{"content":"hi"}}]}' }, // first content
          { data: '{"choices":[{"delta":{"content":" there"}}]}' },
        ]),
        env,
      ),
    )
    const a = env.ctx.currentAttempt!
    expect(a.upstreamFirstTokenAt).toBeGreaterThan(0)
    expect(a.upstreamLastTokenAt).toBeGreaterThanOrEqual(a.upstreamFirstTokenAt!)
    expect(a.upstreamMessageStartAt).toBeUndefined() // non-Anthropic has no message_start frame
  })
})

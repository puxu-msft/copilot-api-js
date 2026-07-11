/**
 * L2 缓冲重试也发 `request.attempt_failed`（BLOCK-1）。
 *
 * 项目有两层重试：L1 反应式（在 `runExchange` 内因上游 error 触发，已发 `attempt_failed`）
 * 与 L2 缓冲重试（buffered sink 因截断/transport-close 反复 re-run `runExchange`）。
 * 在此改动前，L2 重试**从不**调 `recordAttemptFailure`，所以其失败 attempt 在 `[RETRY]`
 * 行完全不可见，且截断路径既不走 `setAttemptError` 也不走 `setAttemptResponse`，durationMs
 * 停在 `beginAttempt` 初值 0（`isValidLastMs` 因此判无效，汇总退化为 `total(N)`）。
 *
 * 本测试用真实 `createRequestContext({ endpoint: "anthropic-messages" })` + mock transport
 * 构造「首个 attempt 截断（无 message_stop）→ 第二个 attempt 完整成功」，断言中途恰好发一条
 * `attempt_failed`，其 `attempt.durationMs > 0`，`nextStrategy === "buffered-retry"`。
 * 参照 tests/pipeline/buffered-sink.unit.test.ts 的驱动方式。
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ObservabilityEvent,
  ScopedPublisher,
} from "~/lib/observability"
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  ClientFrame,
  FormatCodec,
  PreparedRequest,
  RunBufferedOpts,
  Transport,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

import { createRequestContext } from "~/lib/context/request"
import { makeArraySink } from "~/lib/pipeline/client-sink"
import {
  //
  createPipelineDriver,
  type DriverDeps,
} from "~/lib/pipeline/driver"

// ── frame fixtures ──────────────────────────────────────────────────────────

function f(type: string, extra: Record<string, unknown> = {}): UpstreamFrame {
  return { event: type, data: JSON.stringify({ type, ...extra }) } as UpstreamFrame
}
const completeFrames = (msgId: string): Array<UpstreamFrame> => [
  f("message_start", { message: { id: msgId } }),
  f("content_block_start", { index: 0, content_block: { type: "tool_use", name: "Write" } }),
  f("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"x":1}' } }),
  f("content_block_stop", { index: 0 }),
  f("message_delta", { delta: { stop_reason: "tool_use" } }),
  f("message_stop"),
]
const partialFrames = (msgId: string): Array<UpstreamFrame> => [
  f("message_start", { message: { id: msgId } }),
  f("content_block_start", { index: 0, content_block: { type: "tool_use", name: "Write" } }),
  f("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"x":' } }),
]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 干净耗尽（无 throw）的上游流，但故意消耗一小段真实墙钟时间，让首个 attempt 的
 * durationMs 在 finalize 时确定性 > 0（微任务级 yield 不保证 Date.now() 前进 ≥1ms，
 * 会使 `durationMs > 0` 断言 flaky）。
 */
async function* framesCleanSlow(items: Array<UpstreamFrame>): AsyncIterable<UpstreamFrame> {
  await delay(3)
  for (const i of items) yield i
}
async function* framesClean(items: Array<UpstreamFrame>): AsyncIterable<UpstreamFrame> {
  for (const i of items) yield i
}
function upstream(frames: AsyncIterable<UpstreamFrame>): UpstreamStream {
  return { frames, headers: new Headers() }
}

// ── mock codec / driver ──────────────────────────────────────────────────────

function makeCodec(): FormatCodec {
  return {
    format: "anthropic",
    parse: () => {
      throw new Error("parse not used")
    },
    decideRoute: () => ({ kind: "passthrough", endpoint: "/v1/messages" }),
    translateOut: (env) => env,
    prepareWire: () => ({ url: "u", headers: new Headers(), body: {}, stream: true }) as PreparedRequest,
    renderResponse: (frame) => frame, // identity (Anthropic bypass-direct)
    renderResponseNonStreaming: (u) => u,
    formatError: () => ({ event: "error", data: "{}" }) as ClientFrame,
    createResponseAccumulator: () => ({ model: "", inputTokens: 0, outputTokens: 0, rawContent: "" }),
  }
}

function makeEnv(events: Array<ObservabilityEvent>): RequestEnvelope {
  const publisher: ScopedPublisher<"request"> = {
    publish: (event) => {
      events.push(event)
    },
    // ctx 只用同步 publish 发 attempt_failed；publishAndFlush 补齐接口，测试路径不触达。
    publishAndFlush: (event) => {
      events.push(event)
      return Promise.resolve({ pendingWsBuffer: 0 })
    },
  }
  const ctx = createRequestContext({ endpoint: "anthropic-messages", publisher })
  return {
    clientFormat: "anthropic",
    targetEndpoint: "/v1/messages",
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

/** A driver whose retry `transport.send` returns the given upstreams in sequence. */
function makeDriver(retryUpstreams: Array<UpstreamStream>) {
  let sendCount = 0
  const transport: Transport = {
    send: () => {
      const u = retryUpstreams[sendCount] ?? retryUpstreams.at(-1)
      sendCount++
      return Promise.resolve(u)
    },
  }
  const deps: DriverDeps = { codec: makeCodec(), transport, strategies: [], maxRetries: 3, maxLearningRetries: 32 }
  return { driver: createPipelineDriver(deps), sendCount: () => sendCount }
}

/** sawMessageStop tracker fed by onUpstreamFrame, reset per attempt. */
function makeStopTracker() {
  let saw = false
  return {
    onUpstreamFrame: (frame: UpstreamFrame) => {
      try {
        if ((JSON.parse(frame.data ?? "{}") as { type?: string }).type === "message_stop") saw = true
      } catch {
        /* ignore */
      }
    },
    onAttemptReset: () => {
      saw = false
    },
    sawMessageStop: () => saw,
  }
}

describe("L2 缓冲重试发 attempt_failed", () => {
  test("首个 attempt 截断→重试成功：中途一条 attempt_failed，durationMs 非 0，nextStrategy=buffered-retry", async () => {
    const events: Array<ObservabilityEvent> = []
    const env = makeEnv(events)
    env.ctx.beginAttempt({}) // 模拟 runRequest 的首个 exchange（attempt 0）
    // 首个 attempt 干净耗尽但无 message_stop（Bun clean-RST 形状 = 截断），且消耗真实墙钟。
    const first = upstream(framesCleanSlow(partialFrames("msg_trunc")))
    const { driver } = makeDriver([upstream(framesClean(completeFrames("msg_ok")))])
    const { sink } = makeArraySink()
    const tracker = makeStopTracker()

    const outcome = await driver.runResponseBufferedSink(first, env, sink, { ...tracker, retryCap: 2 } as RunBufferedOpts)

    // 最终成功提交完整生成。
    expect(outcome.kind).toBe("complete")

    // 中途恰好发一条 attempt_failed（L1 未触发——无上游 error；只有 L2 截断重试发）。
    const failed = events.filter((e): e is Extract<ObservabilityEvent, { kind: "request.attempt_failed" }> => e.kind === "request.attempt_failed")
    expect(failed).toHaveLength(1)
    // 该失败 attempt 的 durationMs 已 finalize 为真值（截断路径无 setter，靠 finalizeCurrentAttemptDuration）。
    expect(failed[0].attempt.durationMs).toBeGreaterThan(0)
    // strategy 标记 buffered-retry（供 [RETRY] 行展示）。
    expect(failed[0].nextStrategy).toBe("buffered-retry")
    expect(failed[0].willRetry).toBe(true)
  })
})

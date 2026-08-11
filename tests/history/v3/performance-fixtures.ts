import type {
  //
  ModelOperationRecord,
  OperationKind,
} from "~/lib/context/model-operation-record"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"

const EPOCH = 1_750_000_000_000

function deterministicText(seed: number, bytes: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  let out = ""
  let state = (seed + 1) >>> 0
  while (out.length < bytes) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    out += alphabet[state % alphabet.length]
  }
  return out
}

function sseFrame(index: number, textBytes: number): Readonly<Record<string, unknown>> {
  return {
    event: "content_block_delta",
    data: JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: deterministicText(index % 97, textBytes) },
    }),
  }
}

function beginRecord(id: string, kind: OperationKind = "generation") {
  return createModelOperationRecorder({
    identity: {
      operationId: id,
      kind,
      createdAt: EPOCH,
      sessionId: `session-${kind}`,
      process: { pid: 42, bootTime: EPOCH - 10_000, version: "perf" },
    },
  })
}

export function longConversationFixture(id = "perf-long", turns = 96, messageBytes = 1_024): ModelOperationRecord {
  const recorder = beginRecord(id)
  const messages = Array.from({ length: turns }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: deterministicText(index, messageBytes),
  }))
  const body = { model: "claude-opus-4.8", stream: true, messages }
  const request = recorder.registerPayload(body, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ format: "anthropic-messages", method: "POST", path: "/v1/messages", request: { payload: request } })
  recorder.recordRouting({ requestedModel: "opus", resolvedModel: "claude-opus-4.8", upstreamEndpoint: "/v1/messages", transport: "http" })
  const attempt = recorder.beginAttempt({ transport: "http", effectiveRequest: { payload: request }, upstreamRequest: { payload: request } })
  const frames = Array.from({ length: Math.max(16, turns) }, (_, index) =>
    recorder.registerFrame(sseFrame(index, 96), { origin: { stage: "upstream-capture", track: "upstream", attempt }, mediaType: "text/event-stream" }),
  )
  recorder.settleAttempt(attempt, { verdict: "committed", upstreamResponse: { frames, status: 200 } })
  recorder.recordEgress({ upstream: { frames, status: 200 }, client: { frames, status: 200 } })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt, usage: { inputTokens: turns * 250, outputTokens: turns * 8 } })
}

export function highBranchFixture(id = "perf-branch", branches = 12, branchBytes = 12_000): ModelOperationRecord {
  const recorder = beginRecord(id)
  const ingress = recorder.registerPayload({ model: "gpt-5.6", prompt: deterministicText(1, branchBytes) }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ format: "openai-responses", method: "POST", path: "/v1/responses", request: { payload: ingress } })
  recorder.recordRouting({ requestedModel: "gpt", resolvedModel: "gpt-5.6", upstreamEndpoint: "/responses", transport: "upstream-ws" })
  let committedAttempt: ReturnType<typeof recorder.beginAttempt> | undefined
  for (let index = 0; index < branches; index++) {
    const effective = recorder.registerPayload(
      { branch: index, input: deterministicText(index + 10, branchBytes) },
      { origin: { stage: "effective-request", track: "proxy" } },
    )
    const attempt = recorder.beginAttempt({
      strategy: index === 0 ? "initial" : `retry-${index}`,
      transport: index % 2 === 0 ? "upstream-ws" : "upstream-ws-fallback",
      effectiveRequest: { payload: effective },
      upstreamRequest: { payload: effective },
    })
    recorder.recordAttemptDiagnostic(attempt, {
      kind: "branch-decision",
      severity: index === branches - 1 ? "info" : "warning",
      data: { branch: index, rejectedFeatures: Array.from({ length: index % 5 }, (_, feature) => `feature-${feature}`) },
    })
    const result = recorder.registerPayload(
      { branch: index, response: deterministicText(index + 100, 2_048) },
      { origin: { stage: "upstream-response", track: "upstream", attempt } },
    )
    const committed = index === branches - 1
    recorder.settleAttempt(attempt, {
      verdict: committed ? "committed" : "discarded",
      upstreamResponse: { payload: result, status: committed ? 200 : 400 },
      reason: committed ? "accepted" : "reactive retry",
    })
    if (committed) committedAttempt = attempt
  }
  recorder.recordEgress({ client: { payload: ingress, status: 200 } })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt })
}

export function largeSseFixture(id = "perf-sse", frameCount = 2_048, frameTextBytes = 192): ModelOperationRecord {
  const recorder = beginRecord(id)
  const request = recorder.registerPayload(
    { model: "claude-sonnet-4.6", messages: [{ role: "user", content: "large SSE" }] },
    { origin: { stage: "ingress", track: "client" } },
  )
  recorder.recordIngress({ format: "anthropic-messages", request: { payload: request } })
  recorder.recordRouting({ requestedModel: "sonnet", resolvedModel: "claude-sonnet-4.6", upstreamEndpoint: "/v1/messages", transport: "http" })
  const attempt = recorder.beginAttempt({ transport: "http", effectiveRequest: { payload: request }, upstreamRequest: { payload: request } })
  const frames = Array.from({ length: frameCount }, (_, index) =>
    recorder.registerFrame(sseFrame(index, frameTextBytes), {
      origin: { stage: "upstream-capture", track: "upstream", attempt },
      mediaType: "text/event-stream",
    }),
  )
  recorder.settleAttempt(attempt, { verdict: "committed", upstreamResponse: { frames, status: 200 } })
  recorder.recordEgress({ upstream: { frames, status: 200 }, client: { frames, status: 200 } })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt })
}

export function bufferedRetryFixture(id = "perf-buffered", attempts = 4, framesPerAttempt = 256): ModelOperationRecord {
  const recorder = beginRecord(id)
  const request = recorder.registerPayload(
    { model: "claude-opus-4.8", messages: [{ role: "user", content: deterministicText(7, 8_192) }] },
    { origin: { stage: "ingress", track: "client" } },
  )
  recorder.recordIngress({ format: "anthropic-messages", request: { payload: request } })
  recorder.recordRouting({ resolvedModel: "claude-opus-4.8", upstreamEndpoint: "/v1/messages", transport: "http" })
  let committedAttempt: ReturnType<typeof recorder.beginAttempt> | undefined
  let committedFrames: Array<ReturnType<typeof recorder.registerFrame>> = []
  for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex++) {
    const attempt = recorder.beginAttempt({
      strategy: attemptIndex === 0 ? "initial" : "buffered-retry",
      transport: "http",
      effectiveRequest: { payload: request },
      upstreamRequest: { payload: request },
    })
    const frames = Array.from({ length: framesPerAttempt }, (_, frameIndex) =>
      recorder.registerFrame(sseFrame(frameIndex + attemptIndex * 17, 160), {
        origin: { stage: "upstream-capture", track: "upstream", attempt },
        mediaType: "text/event-stream",
      }),
    )
    const committed = attemptIndex === attempts - 1
    recorder.settleAttempt(attempt, {
      verdict: committed ? "committed" : "discarded",
      upstreamResponse: { frames, status: committed ? 200 : 502 },
      reason: committed ? "complete" : "buffered transport close",
    })
    if (committed) {
      committedAttempt = attempt
      committedFrames = frames
    }
  }
  recorder.recordEgress({ upstream: { frames: committedFrames }, client: { frames: committedFrames } })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt })
}

export function countTokensFloodFixtures(count = 256): Array<ModelOperationRecord> {
  return Array.from({ length: count }, (_, index) => {
    const recorder = beginRecord(`perf-count-${index}`, "count_tokens")
    const request = recorder.registerPayload(
      { model: "claude-haiku-4.5", messages: [{ role: "user", content: deterministicText(index % 13, 256) }] },
      { origin: { stage: "ingress", track: "client" } },
    )
    recorder.recordIngress({ format: "anthropic-messages", path: "/v1/messages/count_tokens", request: { payload: request } })
    recorder.recordRouting({ resolvedModel: "claude-haiku-4.5", transport: "local" })
    const attempt = recorder.beginAttempt({ effectiveRequest: { payload: request }, upstreamRequest: { payload: request } })
    const result = recorder.registerPayload({ input_tokens: 64 + (index % 17) }, { origin: { stage: "local-result", track: "internal", attempt } })
    recorder.settleAttempt(attempt, { verdict: "committed", upstreamResponse: { payload: result, status: 200 } })
    recorder.recordEgress({ upstream: { payload: result }, client: { payload: result, status: 200 } })
    return recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt, usage: { inputTokens: 64 + (index % 17) } })
  })
}

export function embeddingBatchFixture(id = "perf-embeddings", items = 256, dimensions = 64): ModelOperationRecord {
  const recorder = beginRecord(id, "embeddings")
  const input = Array.from({ length: items }, (_, index) => deterministicText(index, 256))
  const request = recorder.registerPayload({ model: "text-embedding-3-small", input }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ format: "openai-embeddings", path: "/v1/embeddings", request: { payload: request } })
  recorder.recordRouting({ resolvedModel: "text-embedding-3-small", upstreamEndpoint: "/embeddings", transport: "http" })
  const attempt = recorder.beginAttempt({ transport: "http", effectiveRequest: { payload: request }, upstreamRequest: { payload: request } })
  const vectors = Array.from({ length: items }, (_, item) =>
    Array.from({ length: dimensions }, (_, dimension) => ((item * 31 + dimension * 17) % 1_009) / 1_009),
  )
  const response = recorder.registerPayload(
    { data: vectors, usage: { prompt_tokens: items * 64, total_tokens: items * 64 } },
    { origin: { stage: "upstream-response", track: "upstream", attempt } },
  )
  recorder.settleAttempt(attempt, { verdict: "committed", upstreamResponse: { payload: response, status: 200 } })
  recorder.recordEgress({ upstream: { payload: response }, client: { payload: response, status: 200 } })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: attempt, usage: { inputTokens: items * 64 } })
}

export const topThreeFixtures = {
  longConversation: longConversationFixture,
  highBranch: highBranchFixture,
  largeSse: largeSseFixture,
} as const

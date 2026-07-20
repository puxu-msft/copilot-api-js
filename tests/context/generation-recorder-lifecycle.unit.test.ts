import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestContext } from "~/lib/context/request"

import { createRequestContext } from "~/lib/context/request"
import { HTTPError } from "~/lib/error"
import { createBus } from "~/lib/observability"
import {
  //
  initProcessIdentity,
  resetProcessIdentityForTests,
} from "~/lib/process-identity"

describe("RequestContext generation recorder lifecycle", () => {
  test("captures identity, ingress, routing, attempt verdicts, diagnostics, and seals only after the V2 terminal event", async () => {
    resetProcessIdentityForTests()
    const processIdentity = initProcessIdentity("9.9.9-test")
    let terminalWasCommittedAtV2Publish = false
    const bus = createBus()
    const ctx: RequestContext = createRequestContext({
      endpoint: "anthropic-messages",
      sessionId: "session-generation-1",
      agentId: "agent-generation-1",
      method: "POST",
      path: "/v1/messages",
      publisher: bus.scope("request"),
    })
    bus.subscribe((event) => {
      if (event.kind === "request.completed") terminalWasCommittedAtV2Publish = ctx.modelOperationTerminalRecord !== null
    })

    expect(ctx.modelOperationSnapshot.identity).toMatchObject({
      operationId: ctx.id,
      kind: "generation",
      sessionId: "session-generation-1",
      agentId: "agent-generation-1",
      process: processIdentity,
    })
    expect(ctx.modelOperationTerminalRecord).toBeNull()

    const original = {
      model: "claude-opus-4.8",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      payload: { model: "claude-opus-4.8", messages: [{ role: "user", content: "hello" }], stream: true },
    }
    ctx.setOriginalRequest(original)
    ctx.setInboundRequestHeaders({ authorization: "Bearer client", "x-request-id": "ingress-1" })
    ctx.recordModelOperationIngress()
    expect(ctx.modelOperationSnapshot.ingress?.request.payload).toBeDefined()
    expect(ctx.modelOperationSnapshot.ingress?.request.headers).toEqual([
      ["authorization", "Bearer client"],
      ["x-request-id", "ingress-1"],
    ])
    expect(ctx.modelOperationSnapshot.ingress?.request.rawCapture).toMatchObject({
      capability: "unavailable",
      gap: expect.stringContaining("repeated header"),
    })
    expect(() => ctx.setOriginalRequest(original)).toThrow(/original request.*already|ingress.*already/i)

    ctx.setResolvedModel({ resolved: "claude-opus-4.8" })
    ctx.setRouteInfo?.({ outboundEndpoint: "/v1/messages", translated: false })

    ctx.beginAttempt({})
    ctx.setAttemptEffectiveRequest({
      model: "claude-opus-4.8",
      resolvedModel: undefined,
      messages: original.messages,
      payload: original.payload,
      format: "anthropic-messages",
    })
    ctx.setAttemptWireRequest({
      model: "claude-opus-4.8",
      messages: original.messages,
      payload: original.payload,
      headers: { "anthropic-version": "2023-06-01" },
      format: "anthropic-messages",
    })
    ctx.setAttemptTimingEpoch!("upstreamHeadersAt", 101, "once")
    const rejectedFrame = { event: "error", data: JSON.stringify({ type: "error", error: { message: "unsupported beta" } }) }
    ctx.captureUpstreamGenerationFrame!(rejectedFrame, { offsetMs: 1, type: "error", raw: rejectedFrame.data })
    ctx.recordRepairOutcome({ outcome: "jsonrepair", tool: "Edit", beforeLength: 4, afterLength: 5 })
    ctx.setAttemptError({ type: "bad_request", status: 400, message: "unsupported beta", raw: new Error("unsupported beta") })
    ctx.recordAttemptFailure({ willRetry: true, nextStrategy: "unsupported-beta-retry", learning: true })

    ctx.beginAttempt({ strategy: "unsupported-beta-retry" })
    ctx.setAttemptTimingEpoch!("upstreamFirstTokenAt", 202, "once")
    ctx.setAttemptTimingEpoch!("upstreamLastTokenAt", 303, "latest")
    ctx.setClientTimingEpoch("firstReal", 404)
    ctx.complete({
      success: true,
      model: "claude-opus-4.8",
      usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3 },
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
    })

    expect(ctx.modelOperationTerminalRecord).toBeNull()
    ctx.finalizeModelOperationDelivery({ clientPayload: { type: "message", role: "assistant", content: [{ type: "text", text: "done" }] } })
    await ctx.whenModelOperationFinalized()

    const terminal = ctx.modelOperationTerminalRecord
    expect(terminalWasCommittedAtV2Publish).toBe(false)
    expect(terminal).not.toBeNull()
    expect(terminal).toBe(ctx.modelOperationSnapshot)
    expect(terminal?.routing).toMatchObject({
      requestedModel: "claude-opus-4.8",
      resolvedModel: "claude-opus-4.8",
      clientFormat: "anthropic",
      upstreamEndpoint: "/v1/messages",
    })
    expect(terminal?.attempts.map((attempt) => attempt.verdict)).toEqual(["discarded", "committed"])
    expect(terminal?.attempts[0]).toMatchObject({
      reason: "retry:unsupported-beta-retry",
    })
    expect(terminal?.attempts[0]?.effectiveRequest?.payload).toMatch(/^payload:/)
    expect(terminal?.attempts[0]?.upstreamRequest?.payload).toMatch(/^payload:/)
    expect(terminal?.attempts[0]?.upstreamResponse?.frames).toHaveLength(1)
    expect(terminal?.attempts[0]?.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(
      expect.arrayContaining(["timing.upstreamHeadersAt", "repair.jsonrepair", "upstream_error", "retry"]),
    )
    expect(terminal?.attempts[1]?.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(
      expect.arrayContaining(["timing.upstreamFirstTokenAt", "timing.upstreamLastTokenAt", "timing.client.firstReal"]),
    )
    expect(terminal?.attempts[1]?.upstreamResponse?.rawCapture).toMatchObject({
      capability: "unavailable",
      gap: expect.stringContaining("repeated header/trailer"),
    })
    expect(terminal?.terminal).toMatchObject({
      outcome: "completed",
      usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 3 },
    })

    const sequence = terminal!.lastSequence
    ctx.setClientTimingEpoch("streamOpen", 999)
    ctx.recordRepairOutcome({ outcome: "unrepairable", tool: "Late" })
    expect(ctx.modelOperationSnapshot.lastSequence).toBe(sequence)
  })
})

describe("RequestContext generation terminal ordering", () => {
  test("fail records the logical outcome but delivery finalization seals later", async () => {
    const bus = createBus()
    const ctx = createRequestContext({ endpoint: "anthropic-messages", publisher: bus.scope("request") })
    ctx.beginAttempt({})
    let terminalAtPublish: unknown
    bus.subscribe((event) => {
      if (event.kind === "request.failed") terminalAtPublish = ctx.modelOperationTerminalRecord?.terminal
    })

    ctx.fail("m", new Error("upstream failed"))

    expect(terminalAtPublish).toBeUndefined()
    expect(ctx.modelOperationTerminalRecord).toBeNull()
    ctx.finalizeModelOperationDelivery()
    await ctx.whenModelOperationFinalized()
    expect(ctx.modelOperationTerminalRecord?.terminal).toMatchObject({ outcome: "failed" })
    expect(ctx.modelOperationTerminalRecord?.attempts[0]?.verdict).toBe("failed")
    expect(ctx.modelOperationSnapshot).toBe(ctx.modelOperationTerminalRecord!)
  })

  test("abort records the logical outcome but delivery finalization seals later", async () => {
    const bus = createBus()
    const ctx = createRequestContext({ endpoint: "openai-responses", publisher: bus.scope("request") })
    ctx.beginAttempt({})
    let terminalAtPublish: unknown
    bus.subscribe((event) => {
      if (event.kind === "request.aborted") terminalAtPublish = ctx.modelOperationTerminalRecord?.terminal
    })

    ctx.abort("m")

    expect(terminalAtPublish).toBeUndefined()
    ctx.finalizeModelOperationDelivery()
    await ctx.whenModelOperationFinalized()
    expect(ctx.modelOperationTerminalRecord?.terminal).toMatchObject({ outcome: "aborted", attribution: { category: "client", code: "client-disconnected" } })
    expect(ctx.modelOperationTerminalRecord?.attempts[0]?.verdict).toBe("failed")
    expect(ctx.modelOperationSnapshot).toBe(ctx.modelOperationTerminalRecord!)
  })

  test("joins an early delivery finalization with a later middleware logical outcome", async () => {
    const ctx = createRequestContext({ endpoint: "openai-responses" })
    const clientBody = { error: { message: "route rejected" } }

    ctx.finalizeModelOperationDelivery({ clientPayload: clientBody })
    expect(ctx.modelOperationTerminalRecord).toBeNull()
    ctx.fail("m", new Error("route rejected"))
    await ctx.whenModelOperationFinalized()

    const record = ctx.modelOperationTerminalRecord!
    expect(record.terminal?.outcome).toBe("failed")
    expect(record.arena.payloads.find((node) => node.handle === record.egress?.client.payload)?.value).toEqual(clientBody)
  })

  test("preserves an HTTPError raw response as the primary upstream payload and JSON error fields", async () => {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    const rawBody = JSON.stringify({ type: "error", error: { message: "bad beta" } })
    const error = new HTTPError("bad beta", 400, rawBody)
    ctx.beginAttempt({})
    ctx.setAttemptError({ type: "bad_request", status: 400, message: error.message, raw: error })

    ctx.fail("m", error)
    ctx.finalizeModelOperationDelivery({ clientPayload: { type: "error", error: { message: "bad beta" } } })
    await ctx.whenModelOperationFinalized()

    const record = ctx.modelOperationTerminalRecord!
    const upstreamHandle = record.dispatches[0]?.upstreamResponse?.payload
    expect(record.arena.payloads.find((node) => node.handle === upstreamHandle)?.value).toBe(rawBody)
    // Intentionally exercise the persistence-neutral JSON wire round-trip, not merely cloning.
    // eslint-disable-next-line unicorn/prefer-structured-clone
    const roundTripped = JSON.parse(JSON.stringify(record)) as typeof record
    expect(roundTripped.dispatches[0]?.error).toMatchObject({ name: "HTTPError", message: "bad beta", status: 400, responseText: rawBody })
    expect(roundTripped.terminal?.error).toMatchObject({ name: "HTTPError", message: "bad beta", status: 400, responseText: rawBody })
    expect(roundTripped.dispatches[0]?.error).toHaveProperty("stack")
  })

  test("preserves the complete upstream envelope when a semantic response receives a failed verdict", async () => {
    const ctx = createRequestContext({ endpoint: "openai-responses" })
    const sourceBody = {
      id: "resp_truncated",
      status: "in_progress",
      output: [],
      provider_extra: { trace_id: "must-survive" },
    }
    ctx.beginAttempt({})

    ctx.fail("gpt-test", new Error("semantic truncation"), {
      usage: { input_tokens: 3, output_tokens: 1 },
      content: null,
      sourceBody,
    })
    ctx.finalizeModelOperationDelivery({ clientPayload: sourceBody })
    await ctx.whenModelOperationFinalized()

    const record = ctx.modelOperationTerminalRecord!
    const upstreamHandle = record.dispatches[0]?.upstreamResponse?.payload
    expect(record.arena.payloads.find((node) => node.handle === upstreamHandle)?.value).toEqual(sourceBody)
    expect(record.terminal?.outcome).toBe("failed")
  })
})

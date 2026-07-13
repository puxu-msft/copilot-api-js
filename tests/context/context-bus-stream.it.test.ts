/**
 * P0.3 golden fixture — captures the request.* bus event STREAM produced by a
 * full lifecycle driven through `RequestContextManager` + `RequestContext`.
 *
 * This is the equivalence guard for the observability dual-track collapse
 * (docs/v4 P0.3): the legacy `ctx.emit() → manager.handleContextEvent → bus`
 * bridge is being replaced by ctx publishing `request.*` directly. The bus
 * event SET (kinds, order, per-event discriminant fields, and the
 * summary-presence invariant) MUST stay identical before and after.
 *
 * Volatile fields (id / startTime / durationMs / lastUpdatedAt / timestamps)
 * are intentionally NOT asserted — only the stream shape + stable discriminants.
 *
 * Lifecycle events (created / state_changed / context_updated / completed /
 * failed / aborted) carry `ctx.summary`; the strongly-typed direct events
 * (model_resolved / feature_applied / stream_progress / attempt_*) do NOT.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ApiError } from "~/lib/error"
import type { ObservabilityEvent } from "~/lib/observability"

import { createRequestContextManager } from "~/lib/context/manager"
import { createBus } from "~/lib/observability"

/** One recorded bus event reduced to its stream-shape-defining fields. */
interface StreamRow {
  kind: string
  hasSummary: boolean
  field?: string
  previousState?: string
  state?: string
  feature?: string
  attemptIndex?: number
}

function reduce(event: ObservabilityEvent): StreamRow {
  const row: StreamRow = {
    kind: event.kind,
    hasSummary: "ctx" in event && event.ctx.summary !== undefined,
  }
  if (event.kind === "request.context_updated") row.field = event.field
  if (event.kind === "request.state_changed") {
    row.previousState = event.previousState
    row.state = event.ctx.state
  }
  if (event.kind === "request.completed" || event.kind === "request.failed" || event.kind === "request.aborted") {
    row.state = event.ctx.state
  }
  if (event.kind === "request.feature_applied") row.feature = event.feature
  if (event.kind === "request.attempt_started" || event.kind === "request.attempt_failed") row.attemptIndex = event.attempt.attemptIndex
  return row
}

function setup() {
  const bus = createBus()
  const rows: Array<StreamRow> = []
  bus.subscribe((e) => {
    rows.push(reduce(e))
  })
  const manager = createRequestContextManager({ publisher: bus.scope("request") })
  return { manager, rows }
}

const ERROR_413: ApiError = { status: 413, message: "Payload too large", type: "payload_too_large", raw: null as never }

describe("P0.3 bus event stream — golden", () => {
  test("success flow emits the expected event stream", () => {
    const { manager, rows } = setup()

    const ctx = manager.create({ endpoint: "anthropic-messages", method: "POST", path: "/v1/messages" })
    ctx.setResolvedModel({ resolved: "claude-opus-4.8", client: "opus" })
    ctx.setOriginalRequest({ model: "opus", messages: [{ role: "user", content: "hi" }], stream: true, payload: { model: "opus" } })
    ctx.transition("executing")
    ctx.beginAttempt({})
    ctx.setAttemptEffectiveRequest({ model: "claude-opus-4.8", resolvedModel: undefined, messages: [], payload: {}, format: "anthropic-messages" })
    ctx.setAttemptWireRequest({ model: "claude-opus-4.8", messages: [], payload: {}, headers: {}, format: "anthropic-messages" })
    ctx.recordFeature("via-responses")
    ctx.addQueueWaitMs(100)
    ctx.transition("streaming")
    ctx.complete({ success: true, model: "claude-opus-4.8", usage: { input_tokens: 1, output_tokens: 2 }, content: null })

    expect(rows).toEqual([
      { kind: "request.created", hasSummary: true },
      { kind: "request.model_resolved", hasSummary: false },
      { kind: "request.context_updated", hasSummary: true, field: "originalRequest" },
      { kind: "request.state_changed", hasSummary: true, previousState: "pending", state: "executing" },
      { kind: "request.context_updated", hasSummary: true, field: "attempts" },
      { kind: "request.context_updated", hasSummary: true, field: "attempts" },
      { kind: "request.context_updated", hasSummary: true, field: "attempts" },
      { kind: "request.feature_applied", hasSummary: false, feature: "via-responses" },
      { kind: "request.context_updated", hasSummary: true, field: "queueWaitMs" },
      { kind: "request.state_changed", hasSummary: true, previousState: "executing", state: "streaming" },
      { kind: "request.state_changed", hasSummary: true, previousState: "streaming", state: "completed" },
      { kind: "request.completed", hasSummary: true, state: "completed" },
    ])
    expect(manager.get(ctx.id)).toBeUndefined() // removed from active on terminal
  })

  test("failure flow emits the expected event stream", () => {
    const { manager, rows } = setup()

    const ctx = manager.create({ endpoint: "anthropic-messages", method: "POST", path: "/v1/messages" })
    ctx.setOriginalRequest({ model: "opus", messages: [], stream: false, payload: {} })
    ctx.transition("executing")
    ctx.beginAttempt({})
    ctx.setAttemptError(ERROR_413)
    ctx.recordAttemptFailure({ willRetry: false })
    ctx.fail("opus", new Error("boom"))

    expect(rows).toEqual([
      { kind: "request.created", hasSummary: true },
      { kind: "request.context_updated", hasSummary: true, field: "originalRequest" },
      { kind: "request.state_changed", hasSummary: true, previousState: "pending", state: "executing" },
      { kind: "request.context_updated", hasSummary: true, field: "attempts" },
      { kind: "request.attempt_failed", hasSummary: false, attemptIndex: 0 },
      { kind: "request.state_changed", hasSummary: true, previousState: "executing", state: "failed" },
      { kind: "request.failed", hasSummary: true, state: "failed" },
    ])
    expect(manager.get(ctx.id)).toBeUndefined()
  })

  test("abort flow emits the expected event stream", () => {
    const { manager, rows } = setup()

    const ctx = manager.create({ endpoint: "anthropic-messages", method: "POST", path: "/v1/messages" })
    ctx.setOriginalRequest({ model: "opus", messages: [], stream: true, payload: {} })
    ctx.transition("executing")
    ctx.abort("opus")

    expect(rows).toEqual([
      { kind: "request.created", hasSummary: true },
      { kind: "request.context_updated", hasSummary: true, field: "originalRequest" },
      { kind: "request.state_changed", hasSummary: true, previousState: "pending", state: "executing" },
      { kind: "request.state_changed", hasSummary: true, previousState: "executing", state: "aborted" },
      { kind: "request.aborted", hasSummary: true, state: "aborted" },
    ])
    expect(manager.get(ctx.id)).toBeUndefined()
  })
})

import { describe, expect, test } from "bun:test"

import { createBus } from "~/lib/observability/bus"
import { createRequestContext } from "~/lib/context/request"

function makeCtx() {
  const bus = createBus()
  return createRequestContext({
    endpoint: "anthropic-messages",
    method: "POST",
    path: "/v1/messages",
    publisher: bus.scope("request"),
  })
}

describe("ctx.setClientTimingEpoch (once) + toHistoryEntry offset projection", () => {
  test("keeps the FIRST epoch per kind, projects offset relative to started_at", () => {
    const ctx = makeCtx()
    const start = ctx.toHistoryEntry().startedAt
    ctx.setClientTimingEpoch("streamOpen", start + 100)
    ctx.setClientTimingEpoch("streamOpen", start + 200) // ignored (once)
    expect(ctx.toHistoryEntry().timing?.client?.streamOpenMs).toBe(100)
  })

  test("three kinds are independent, each projected as epoch - started_at", () => {
    const ctx = makeCtx()
    const start = ctx.toHistoryEntry().startedAt
    ctx.setClientTimingEpoch("streamOpen", start + 20)
    ctx.setClientTimingEpoch("firstReal", start + 80)
    ctx.setClientTimingEpoch("bufferHoldStart", start + 20)
    const c = ctx.toHistoryEntry().timing?.client
    expect(c).toEqual({ streamOpenMs: 20, firstRealMs: 80, bufferHoldStartMs: 20 })
  })

  test("unset kinds leave timing undefined", () => {
    const ctx = makeCtx()
    expect(ctx.toHistoryEntry().timing).toBeUndefined()
  })
})

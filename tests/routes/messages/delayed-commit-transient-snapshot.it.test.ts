/**
 * Unit 1 (reduced) — spec/plan 2026-07-20-synthetic-frame-forwarded-track-completeness §Phase C.
 *
 * SCOPE NOTE: the ORIGINAL Unit-1 premise ("the POST-COMMIT error frame + anchor stop@0 never reach
 * history's clientResponse.sseEvents") is EMPIRICALLY FALSE under History V3 (landed 2026-07-18): the
 * durable projection (v3/projection.ts clientTrack) captures the writeSynthetic frame via the
 * generation recorder even after ctx.fail (seal is deferred). `getHistory(...).clientResponse.sseEvents`
 * already contains the error frame.
 *
 * The RESIDUAL gap this covers is the TRANSIENT snapshot: `ctx.fail` publishes a `request.failed`
 * event whose `entry` comes from `toHistoryEntry()` reading `_forwardedResponse` (set by
 * setForwardedResponse). The delayed-commit catch snapshots pings at the TOP of the catch (before the
 * error frame is written), so the transient event entry is momentarily missing the error frame — the
 * live TUI/WS view sees an incomplete entry until the durable projection supersedes it. The reorder
 * (writeSynthetic → setForwardedResponse → fail, via writeTerminalThenSettle) closes it and aligns with
 * the documented client-sink contract. Wire bytes unchanged.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import type { ObservabilityEvent } from "~/lib/observability/events"

import { setModels } from "~/lib/models/cache"
import { getBus } from "~/lib/observability"
import { setStateForTests } from "~/lib/state"

import { mockModel } from "../../helpers/factories"
import { FakeClock } from "../../helpers/fake-clock"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import { applyFetchMock } from "../../helpers/mock-fetch"

const MODEL = "claude-opus-4.8"

async function drain(n = 120): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe("Unit 1 (reduced) — POST-COMMIT transient `request.failed` snapshot includes the error frame", () => {
  useIsolatedRuntime()
  const clock = new FakeClock()

  let gateReached: () => void
  let gateReachedP: Promise<void>
  let openGate: () => void
  let gateOpenP: Promise<void>

  const gatedFetchMock = mock((input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input
      : input instanceof URL ? input.href
      : input.url
    if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL in mock: ${url}`)
    gateReached()
    return gateOpenP.then(
      () =>
        new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "mock 401" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    )
  })

  beforeEach(() => {
    clock.install()
    gatedFetchMock.mockClear()
    gateReachedP = new Promise<void>((r) => (gateReached = r))
    gateOpenP = new Promise<void>((r) => (openGate = r))
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      streamIdleTimeout: 0,
      streamKeepalivePingSec: 2,
      streamCommitAfterSec: 2,
      streamKeepaliveMode: "ping",
      protectStreamingGeneration: false,
      errorShapingEnabled: true,
    })
    applyFetchMock(gatedFetchMock)
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })

  afterEach(() => clock.restore())

  test("① HTTPError POST-COMMIT → the transient request.failed entry's clientResponse.sseEvents includes the error frame", async () => {
    const failedEntries: Array<Array<{ type?: string }>> = []
    const unsub = getBus().subscribe(
      (e: ObservabilityEvent) => {
        if (e.kind === "request.failed") failedEntries.push((e.entry?.clientResponse?.sseEvents ?? []) as Array<{ type?: string }>)
      },
      (e) => e.kind === "request.failed",
    )
    try {
      const { createFullTestApp } = await import("../../helpers/test-app")
      const app = createFullTestApp()
      const resP = app.request("/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": "u1-transient" },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 256, stream: true }),
      })
      await gateReachedP
      await clock.advance(2_000) // commit window fires → 200 SSE opens
      await drain()
      const res = await resP
      expect(res.status).toBe(200)
      openGate() // upstream 401s POST-COMMIT
      await res.text()
      await drain()

      expect(failedEntries.length).toBeGreaterThan(0)
      const types = failedEntries.at(-1)?.map((e) => e.type) ?? []
      expect(types).toContain("error") // transient snapshot must include the client-received error frame
    } finally {
      unsub()
    }
  })
})

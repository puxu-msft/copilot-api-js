/**
 * Task 5.2 (docs/plan/2026-07-12-upstream-hook-middleware/plan-5-integration-closeout.md) — the
 * OFFLINE REPLAY acceptance test: mounting `replayFromHistory(reqId)` on `exchange` must drive a
 * request end-to-end WITHOUT ever touching the real upstream, and the replayed frames must land on
 * the NEW request's own persisted history entry, correctly marked as hook-produced (not
 * indistinguishable from a genuine GHC response — richest-data-flow).
 *
 * Independent oracle (non-self-validating):
 *   ① zero real transport calls — a counting fake `Transport` that would record ANY invocation.
 *   ② the replayed frames appear on the NEW entry's persisted upstream-original track
 *      (`getEntry(newReqId).attempts.at(-1).upstreamResponse.sseEvents`), each carrying
 *      `synthetic:"hook-replay"` — read from the SAME history store a real request populates, not
 *      from the hook's return value or a driver call log.
 *   ③ content fidelity — the replayed text is the SEED entry's recorded text, verbatim (proves the
 *      hook is replaying recorded history, not fabricating a response that merely LOOKS replayed).
 *   ④ H4 format-layered fidelity: the Anthropic seed's replayed frames carry real `event:` lines
 *      (lossless); a CC-format seed's replay carries NONE (no fabricated event line).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import { getEntry } from "~/lib/history"
import {
  //
  resetUpstreamHook,
  setUpstreamHookForTests,
} from "~/lib/pipeline/hooks/loader"
import { readOrigin } from "~/lib/pipeline/hooks/origin"
import { replayFromHistory } from "~/lib/pipeline/hooks/toolkit"
import { generateId } from "~/lib/utils"

import { commitV3HistoryEntry } from "../../helpers/history-v3-fixtures"
import { historyTestReservation } from "../../helpers/history-terminal-publication"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import {
  //
  anthropicRawRequest,
  anthropicToolBody,
  collectFrames,
  makeCountingTransport,
  makeRealAnthropicDriver,
  seedAnthropicModel,
} from "./real-anthropic-driver-helpers"

/** Seed a terminal Anthropic-format history entry whose LAST attempt carries real-shaped sseEvents,
 *  for `replayFromHistory` to read back — mirrors `toolkit.unit.test.ts`'s `insertReplayFixture`. */
function seedAnthropicEntry(text: string): string {
  const id = generateId()
  commitV3HistoryEntry({
    id,
    startedAt: Date.now(),
    endpoint: "anthropic-messages",
    state: "completed",
    model: { requested: "claude-seed", resolved: "claude-seed" },
    clientRequest: { format: "anthropic-messages", model: "claude-seed", messages: [] },
    attempts: [
      {
        index: 0,
        durationMs: 1,
        upstreamResponse: {
          success: true,
          model: "claude-seed",
          usage: { input_tokens: 0, output_tokens: 0 },
          body: null,
          sseEvents: [
            { offsetMs: 0, type: "message_start", raw: JSON.stringify({ type: "message_start", message: { id: "msg_seed" } }) },
            {
              offsetMs: 1,
              type: "content_block_start",
              raw: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
            },
            { offsetMs: 2, type: "content_block_delta", raw: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) },
            { offsetMs: 3, type: "content_block_stop", raw: JSON.stringify({ type: "content_block_stop", index: 0 }) },
            { offsetMs: 4, type: "message_stop", raw: JSON.stringify({ type: "message_stop" }) },
          ],
        },
      },
    ],
  })
  return id
}

function seedCcEntry(text: string): string {
  const id = generateId()
  commitV3HistoryEntry({
    id,
    startedAt: Date.now(),
    endpoint: "openai-chat-completions",
    state: "completed",
    model: { requested: "gpt-seed", resolved: "gpt-seed" },
    clientRequest: { format: "openai-chat-completions", model: "gpt-seed", messages: [] },
    attempts: [
      {
        index: 0,
        durationMs: 1,
        upstreamResponse: {
          success: true,
          model: "gpt-seed",
          usage: { input_tokens: 0, output_tokens: 0 },
          body: null,
          sseEvents: [
            { offsetMs: 0, type: "message", raw: JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) },
            { offsetMs: 1, type: "message", raw: JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) },
          ],
        },
      },
    ],
  })
  return id
}

describe("Task 5.2 — offline replay end-to-end (replayFromHistory → zero real upstream calls, persisted synthetic marking)", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    resetUpstreamHook()
  })
  afterEach(() => {
    resetUpstreamHook()
  })

  test("① zero real transport calls, ② persisted upstream track marked synthetic:hook-replay, ③ content fidelity, ④ Anthropic lossless event lines", async () => {
    seedAnthropicModel("claude-x")
    const seedId = seedAnthropicEntry("hello from history")

    setUpstreamHookForTests({
      exchange: async () => replayFromHistory(seedId),
    })
    // A transport that would record ANY call — proves the driver truly never touched "upstream".
    const { transport, sendCount } = makeCountingTransport(() => {
      throw new Error("transport.send must NEVER be called during a replay — the hook short-circuits exchange")
    })
    const driver = makeRealAnthropicDriver(transport)

    const result = await driver.runRequest(anthropicRawRequest(anthropicToolBody("claude-x"), historyTestReservation()))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // ① — no real upstream call, for the WHOLE request (request-side AND response-side).
    expect(sendCount()).toBe(0)
    expect(readOrigin(result.upstream)).toBe("hook-replay")

    // Drive S5→S7 (the response side) so `ctx.setSseEvents` actually records the upstream-original
    // track — mirrors what a real handler does after `runRequest` returns.
    const clientFrames = await collectFrames(driver.runResponse(result.upstream, result.env))
    // ③ — content fidelity: the CLIENT actually receives the seed's recorded text (Anthropic direct
    // leg renderResponse is identity, so the client frame IS the upstream frame, verbatim).
    expect(clientFrames.some((f) => typeof f.data === "string" && f.data.includes("hello from history"))).toBe(true)

    result.env.ctx.complete({ success: true, model: "claude-x", usage: { input_tokens: 1, output_tokens: 1 }, content: "hello from history" })
    // V3 canonical persistence: complete() settles the logical context, but the canonical
    // ModelOperationRecord only commits its terminal + publishes once delivery is finalized too
    // (production driven by observabilityMiddleware / the handler's post-stream call) — a direct
    // driver.runRequest()+ctx.complete() test must call it itself (History V2 removal step 2).
    result.env.ctx.finalizeModelOperationDelivery()
    await result.env.ctx.whenModelOperationFinalized() // V3 finalize is async (deferred seal → generation finalizer); await before getEntry to avoid the persist race

    // ② — Independent oracle: the NEW request's OWN persisted history entry (not the seed's, not a
    // driver call log) carries the replayed frames on its upstream-original track, marked
    // hook-replay.
    const newEntry = getEntry(result.env.ctx.id)
    expect(newEntry).toBeDefined()
    const sseEvents = newEntry?.attempts?.at(-1)?.upstreamResponse?.sseEvents ?? []
    expect(sseEvents.length).toBeGreaterThan(0)
    expect(sseEvents.every((e) => e.synthetic === "hook-replay")).toBe(true)
    expect(sseEvents.some((e) => e.raw.includes("hello from history"))).toBe(true)
    // ④ — Anthropic lossless: real event names survived the replay round-trip (not the generic
    // fabricated "message" label a non-Anthropic entry would carry).
    expect(sseEvents.map((e) => e.type)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_stop"])
  })

  test("④ CC entry replay carries NO fabricated event line (H4, non-Anthropic leg)", async () => {
    const ccSeedId = seedCcEntry("cc reply text")

    const s = await replayFromHistory(ccSeedId)
    expect(readOrigin(s)).toBe("hook-replay")
    const frames: Array<{ event?: string; data?: string }> = []
    for await (const f of s.frames) frames.push(f)

    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every((f) => f.event === undefined)).toBe(true)
    expect(frames.some((f) => f.data?.includes("cc reply text"))).toBe(true)
  })

  test("a hook that mounts replayFromHistory for a NON-EXISTENT entry rejects loudly (no silent empty replay)", async () => {
    seedAnthropicModel("claude-x")
    setUpstreamHookForTests({ exchange: async () => replayFromHistory("no-such-entry-id") })
    const { transport, sendCount } = makeCountingTransport(() => {
      throw new Error("transport.send must never be called")
    })
    const driver = makeRealAnthropicDriver(transport)

    await expect(driver.runRequest(anthropicRawRequest(anthropicToolBody("claude-x")))).rejects.toThrow()
    expect(sendCount()).toBe(0)
  })
})

/**
 * Phase 2 Task 2.2 — Responses downstream WS-to-client keepalive parity (R3.5).
 *
 * EMPIRICAL DECISION (protocol-ping vs app-layer frame): the `protocol ping` branch固化 test
 * (`describe("Bun WS protocol ping ...")`) proves WHY the downstream WS path needs an
 * APPLICATION-layer keepalive frame rather than relying on Bun's auto protocol ping/pong:
 *   - Bun.serve DOES auto-send protocol pings (`websocket.sendPings` defaults to `true`) and keeps
 *     its OWN 120s socket idle-timeout alive — a TRANSPORT-level keepalive.
 *   - BUT a protocol ping is delivered to a standard WS consumer as a (non-standard) `ping` event,
 *     NEVER as an application `message`. A Codex-style consumer that resets its idle deadline on
 *     application EVENTS/MESSAGES (exactly like the SSE reader that resets only on emitted SSE
 *     events, spec §4) is therefore NOT kept alive by the protocol ping — the precise WS analog of
 *     "a bare SSE comment does not reset Codex's clock" from Task 2.1.
 * ⟹ downstream WS needs the SAME app-layer `responsesKeepaliveFrame()` the SSE path injects.
 *
 * The `makeWsSink forward-idle injection` describe固化s the app-frame behavior (deterministic
 * FakeClock, 0-flaky by construction).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { SseEventRecord } from "~/lib/history"

import { responsesKeepaliveFrame } from "~/lib/codec/openai-responses/keepalive"
import { makeWsSink } from "~/lib/pipeline/client-sink"

import { FakeClock } from "../helpers/fake-clock"

// A minimal WSContext stand-in capturing `ws.send(data)` payloads (WS frames carry only `data`).
function fakeWs(): { ctx: Parameters<typeof makeWsSink>[0]; sent: Array<string> } {
  const sent: Array<string> = []
  const ctx = { send: (data: string) => void sent.push(data) } as unknown as Parameters<typeof makeWsSink>[0]
  return { ctx, sent }
}

describe("makeWsSink forward-idle keepalive injection (app-layer frame — R3.5)", () => {
  const clock = new FakeClock()
  beforeEach(() => clock.install())
  afterEach(() => clock.restore())

  test("forward-idle injects the keepalive frame, marked synthetic:'keepalive' in the forwarded track", async () => {
    const { ctx, sent } = fakeWs()
    const forwarded: Array<SseEventRecord> = []
    const sink = makeWsSink(ctx, {
      onForwarded: (r) => forwarded.push(r),
      streamStartMs: clock.now,
      heartbeat: { intervalSec: 20, pingFrame: responsesKeepaliveFrame() },
    })

    // < interval → nothing yet.
    await clock.advance(19_000)
    expect(sent).toEqual([])
    // Crossing the 20s forward-silence boundary → exactly one app-layer keepalive frame.
    await clock.advance(1_000)
    expect(sent).toEqual([JSON.stringify({ type: "response.ping" })])
    // Sampled into the forwarded (client-received) track WITH the synthetic marker so history/UI
    // never mistake a stalled-upstream heartbeat for a real Responses event.
    expect(forwarded).toEqual([{ offsetMs: 20_000, type: "response.ping", raw: JSON.stringify({ type: "response.ping" }), synthetic: "keepalive" }])
    sink.close?.()
  })

  test("a real forwarded frame resets the countdown — a steady stream never pings", async () => {
    const { ctx, sent } = fakeWs()
    const sink = makeWsSink(ctx, { heartbeat: { intervalSec: 20, pingFrame: responsesKeepaliveFrame() } })
    for (let i = 0; i < 5; i++) {
      await clock.advance(15_000) // < interval each turn
      await sink.write({ data: JSON.stringify({ type: "response.output_text.delta" }) })
    }
    expect(sent.filter((s) => s === JSON.stringify({ type: "response.ping" }))).toEqual([]) // no keepalive ever
    sink.close?.()
  })

  test("aborted clientAbortSignal suppresses keepalive pings", async () => {
    const { ctx, sent } = fakeWs()
    const ac = new AbortController()
    const sink = makeWsSink(ctx, { heartbeat: { intervalSec: 20, pingFrame: responsesKeepaliveFrame(), clientAbortSignal: ac.signal } })
    ac.abort()
    await clock.advance(60_000)
    expect(sent).toEqual([]) // client gone → no pings
    sink.close?.()
  })

  test("no heartbeat option → byte-identical to before (no timer, no pings)", async () => {
    const { ctx, sent } = fakeWs()
    const forwarded: Array<SseEventRecord> = []
    const sink = makeWsSink(ctx, { onForwarded: (r) => forwarded.push(r), streamStartMs: clock.now })
    await clock.advance(120_000)
    expect(sent).toEqual([]) // no keepalive timer at all
    await sink.write({ data: JSON.stringify({ type: "response.completed" }) })
    expect(sent).toEqual([JSON.stringify({ type: "response.completed" })])
    // Real writes still sample the forwarded track UNMARKED (existing behavior preserved); the
    // offset reflects real elapsed stream time (120s into the stream here).
    expect(forwarded).toEqual([{ offsetMs: 120_000, type: "response.completed", raw: JSON.stringify({ type: "response.completed" }) }])
    sink.close?.()
  })

  test("close() stops the timer — no ping fires after close", async () => {
    const { ctx, sent } = fakeWs()
    const sink = makeWsSink(ctx, { heartbeat: { intervalSec: 20, pingFrame: responsesKeepaliveFrame() } })
    sink.close?.()
    await clock.advance(60_000)
    expect(sent).toEqual([]) // closed before the first tick → no ping
  })
})

describe("Bun WS protocol ping does NOT reach an application consumer as a message (decision固化)", () => {
  // 固化s the EMPIRICAL basis for choosing an app-layer frame: Bun auto-sends protocol pings
  // (sendPings default true) but they surface to a standard WS client as a `ping` EVENT, never an
  // application `message`. So a consumer keyed on messages/events (Codex) is NOT kept alive by them.
  // Bound to 127.0.0.1:0; the server is stopped in `finally` (no leak). Deterministic: we await the
  // ONE application frame's arrival, then assert the protocol ping did not add a second message.
  test("sendPings/idleTimeout accepted; a server protocol ping arrives as a `ping` event, not a `message`", async () => {
    let server: any
    try {
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req, srv) {
          if (srv.upgrade(req)) return undefined
          return new Response("no-upgrade")
        },
        websocket: {
          // The project's hono/bun `websocket` object sets NEITHER option, so Bun's defaults apply
          // (sendPings:true, idleTimeout:120). Set them explicitly here to固化 they are ACCEPTED.
          sendPings: true,
          idleTimeout: 30,
          open(ws) {
            ws.send(JSON.stringify({ type: "response.output_text.delta" })) // one real app frame
            ws.ping(Buffer.from("srv-ping")) // an explicit protocol ping (transport-level)
          },
          message() {
            /* no-op echo */
          },
        },
      })
    } catch (err) {
      throw new Error(`Bun.serve rejected sendPings/idleTimeout websocket options: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      const url = `ws://127.0.0.1:${(server as { port: number }).port}/v1/responses`
      const appMessages: Array<string> = []
      let pingEventObserved = false
      const ws = new WebSocket(url)
      const firstMessage = new Promise<void>((resolve) => {
        ws.addEventListener("message", (e: MessageEvent) => {
          appMessages.push(String(e.data))
          resolve()
        })
        // Non-standard event some runtimes expose for a received protocol ping. CAVEAT: this固化
        // depends on Bun's `WebSocket` dispatching a `ping` event (robust on loopback today); a Bun
        // behavior change would break THIS harness test, not the code under test — the load-bearing
        // assertion is `appMessages` staying at 1 (protocol pings are not application messages).
        ws.addEventListener("ping" as never, () => {
          pingEventObserved = true
        })
      })
      await firstMessage // deterministic: proceed once the ONE app frame has been delivered
      await new Promise((r) => setTimeout(r, 100)) // small grace: a protocol ping (if surfaced as a message) would land here

      // The protocol ping did NOT add a second application message.
      expect(appMessages).toEqual([JSON.stringify({ type: "response.output_text.delta" })])
      // It WAS observed at the transport layer (a `ping` event), confirming Bun sent it — it just
      // isn't an application message, so an app-level idle deadline (Codex) is not reset by it.
      expect(pingEventObserved).toBe(true)
      ws.close()
    } finally {
      ;(server as { stop: (force?: boolean) => void }).stop(true)
    }
  })
})

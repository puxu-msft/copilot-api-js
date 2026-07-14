/**
 * Unit tests for the shared upstream-frame diagnostics primitive.
 *
 * Locks the behaviors the disconnect-log blind-spot fix depends on:
 *   1. `createUpstreamFrameDiagnostics` counts EVERY observed frame — including empty keepalives (gap B):
 *      under-counting wire activity would re-mislead a live stream as silent. (Production never feeds the
 *      `[DONE]` sentinel — the driver gates `onUpstreamFrame` behind `data !== "[DONE]"`; see the driver
 *      integration test for that wiring. `observe` still labels `[DONE]` honestly as a pure-function property.)
 *   2. `upstreamFrameDiagType` produces an HONEST, format-agnostic last-frame label (Responses `type`,
 *      CC `object`, `[DONE]`, keepalive, and `malformed` for garbled data) rather than mislabelling a real
 *      frame as "keepalive".
 *   3. The collector exposes `startedAtMs` (the base its `offsetMs` values share) so the emit derives a
 *      coherent per-attempt `elapsedMs`/`silence`.
 */

import {
  //
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import type { RequestContext } from "~/lib/context/request"

import {
  //
  createUpstreamFrameDiagnostics,
  logUpstreamStreamError,
  logUpstreamStreamTruncation,
  upstreamFrameDiagType,
} from "~/lib/upstream-stream-diagnostics"
import {
  //
  recordUpstreamFrame,
  type StreamPumpState,
} from "~/routes/messages/streaming-pump"

describe("upstreamFrameDiagType", () => {
  test("Responses frame → its `type`", () => {
    expect(upstreamFrameDiagType({ data: JSON.stringify({ type: "response.output_text.delta" }) })).toBe("response.output_text.delta")
  })

  test("CC chunk (no `type`) → its `object`, NOT the keepalive fallback", () => {
    expect(upstreamFrameDiagType({ data: JSON.stringify({ object: "chat.completion.chunk", choices: [] }) })).toBe("chat.completion.chunk")
  })

  test("`[DONE]` terminator → labelled `[DONE]` (pure-function property; production never feeds it)", () => {
    expect(upstreamFrameDiagType({ data: "[DONE]" })).toBe("[DONE]")
  })

  test("empty data → `keepalive` (or the SSE event line when present)", () => {
    expect(upstreamFrameDiagType({ data: "" })).toBe("keepalive")
    expect(upstreamFrameDiagType({ event: "ping", data: "" })).toBe("ping")
  })

  test("malformed DATA-bearing frame → `malformed` (NOT `keepalive`), or its SSE event line", () => {
    // LOW-1: a garbled-data frame is wire activity carrying unparseable content — labelling it `keepalive`
    // (an empty-frame fact) would mislead. Distinct diagnostic facts get distinct labels.
    expect(upstreamFrameDiagType({ data: "{ not json" })).toBe("malformed")
    expect(upstreamFrameDiagType({ event: "message", data: "{ not json" })).toBe("message")
  })
})

describe("createUpstreamFrameDiagnostics", () => {
  test("counts every observed frame incl. empty keepalive (gap B), sums bytes, records honest types", () => {
    const start = Date.now()
    const diag = createUpstreamFrameDiagnostics(start)
    diag.observe({ data: JSON.stringify({ type: "response.created" }) })
    diag.observe({ data: "" }) // empty keepalive — still a frame on the wire (the real production gap-B case)

    expect(diag.sseEvents).toHaveLength(2)
    expect(diag.sseEvents.map((e) => e.type)).toEqual(["response.created", "keepalive"])
    expect(diag.bytesIn).toBe(JSON.stringify({ type: "response.created" }).length + 0)
    // startedAtMs is the anchor every offsetMs shares (MEDIUM-2: the emit derives elapsed from this).
    expect(diag.startedAtMs).toBe(start)
    expect(diag.sseEvents.every((e) => e.offsetMs >= 0)).toBe(true)
  })

  test("empty collector reports zero + its anchor — a genuine no-frame stream is NOT masked", () => {
    const start = Date.now()
    const diag = createUpstreamFrameDiagnostics(start)
    expect(diag.sseEvents).toHaveLength(0)
    expect(diag.bytesIn).toBe(0)
    expect(diag.startedAtMs).toBe(start)
  })
})

describe("logUpstreamStreamError time base (MEDIUM-2 regression)", () => {
  /** Parse `elapsed=Nms` / `silence=Nms` / `frames=N` out of the emitted STREAM DISCONNECT line. */
  function parseDiag(line: string): { elapsed: number; silence: number; frames: number } {
    const num = (re: RegExp): number => Number(re.exec(line)?.[1] ?? Number.NaN)
    return { elapsed: num(/elapsed=(\d+)ms/), silence: num(/silence=(\d+)ms/), frames: num(/frames=(\d+)/) }
  }

  test("emit derives elapsed/silence from the COLLECTOR's startedAtMs, not a request-wide base", () => {
    // Simulate a buffered retry: the request opened at T0, but the FINAL (failing) attempt rebound a fresh
    // collector at T0+150s. A zero-frame final attempt must report `silence` relative to the ATTEMPT start
    // (~0), never the whole-request span (150s) — the exact gpt-5.6-sol misread the fix must not re-create.
    const requestStartMs = 1_000_000
    const attemptStartMs = requestStartMs + 150_000

    setSystemTime(new Date(attemptStartMs))
    const diag = createUpstreamFrameDiagnostics(attemptStartMs) // rebound per-attempt (onAttemptReset)
    // final attempt fails before any frame → zero frames
    setSystemTime(new Date(attemptStartMs + 3)) // 3ms into the failing attempt

    const spy = spyOn(consola, "error").mockImplementation(Object.assign(() => {}, { raw: () => {} }))
    try {
      const emit = (base: number): { elapsed: number; silence: number; frames: number } => {
        spy.mockClear()
        logUpstreamStreamError(new Error("Stream closed with error code NGHTTP2_CANCEL"), {
          model: "gpt-x",
          streamState: { streamStartMs: base, bytesIn: diag.bytesIn, currentBlockType: "" },
          acc: { inputTokens: 0, outputTokens: 0 },
          sseEvents: diag.sseEvents,
        })
        const line = spy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("STREAM DISCONNECT"))
        expect(line).toBeDefined()
        return parseDiag(line as string)
      }

      // FIXED behavior — the pump passes `diag.startedAtMs` (per-attempt): elapsed≈3ms, silence≈3ms.
      const fixed = emit(diag.startedAtMs)
      expect(fixed.frames).toBe(0)
      expect(fixed.elapsed).toBeLessThan(1000)
      expect(fixed.silence).toBeLessThan(1000)

      // POSITIVE CONTROL — passing the request-wide base (the MEDIUM-2 bug) re-produces the misread: the
      // SAME zero-frame attempt reports `silence=150000ms`. Proves the assertion above is not vacuous and
      // that the call site MUST pass the collector's anchor, not the outer request `streamStartMs`.
      const buggy = emit(requestStartMs)
      expect(buggy.frames).toBe(0)
      expect(buggy.elapsed).toBe(150_003)
      expect(buggy.silence).toBe(150_003)
    } finally {
      spy.mockRestore()
      setSystemTime() // restore real clock
    }
  })
})

describe("recordUpstreamFrame native label (LOW-1 parity — no shared/native drift)", () => {
  function freshState(): StreamPumpState {
    return { streamStartMs: Date.now(), bytesIn: 0, eventsIn: 0, currentBlockType: "", firstEventLogged: false, recoverFeatureLogged: false }
  }
  const noopCtx = { recordStreamProgress: () => {} } as unknown as RequestContext

  test("the native Anthropic pump labels a malformed DATA-bearing frame `malformed`, NOT `keepalive` (delegates to upstreamFrameDiagType)", () => {
    const sseEvents: Array<{ type: string; raw: string; offsetMs: number }> = []
    // parsed=undefined mirrors the native onUpstreamFrame after a JSON.parse throw on a garbled frame.
    recordUpstreamFrame({
      rawEvent: { data: "{ not json" },
      parsed: undefined,
      streamState: freshState(),
      sseEvents,
      reqCtx: noopCtx,
      checkRepetition: () => {},
    })
    expect(sseEvents).toHaveLength(1)
    // Pre-fix this was `keepalive` (the empty-frame label) — the native pump and the shared collector
    // must agree, and both now route through `upstreamFrameDiagType`.
    expect(sseEvents[0]?.type).toBe("malformed")
    expect(sseEvents[0]?.type).toBe(upstreamFrameDiagType({ data: "{ not json" }))
  })

  test("empty keepalive frame → `keepalive` (parity with the shared collector)", () => {
    const sseEvents: Array<{ type: string; raw: string; offsetMs: number }> = []
    recordUpstreamFrame({ rawEvent: { data: "" }, parsed: undefined, streamState: freshState(), sseEvents, reqCtx: noopCtx, checkRepetition: () => {} })
    expect(sseEvents[0]?.type).toBe("keepalive")
  })
})

describe("logUpstreamStreamTruncation (HIGH-1 — clean-EOF truncation label)", () => {
  test("emits kind=truncated with real signals, NOT run through classifyStreamError, NEVER the middlebox hint", () => {
    const start = Date.now()
    const diag = createUpstreamFrameDiagnostics(start)
    // A short thinking-stall-shaped stream: last real frame is a content_block_start (the very signal
    // that WOULD trip the middlebox-idle-reclaim hint IF this were mislabelled transport-close).
    diag.observe({ data: JSON.stringify({ type: "content_block_start" }) })

    const spy = spyOn(consola, "error").mockImplementation(Object.assign(() => {}, { raw: () => {} }))
    try {
      logUpstreamStreamTruncation("Upstream stream truncated before completion (no message_stop)", {
        model: "claude-x",
        streamState: { streamStartMs: diag.startedAtMs, bytesIn: diag.bytesIn, currentBlockType: "thinking" },
        acc: { inputTokens: 5, outputTokens: 0 },
        sseEvents: diag.sseEvents,
      })
      const line = spy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("STREAM DISCONNECT"))
      expect(line).toBeDefined()
      // Fixed `truncated` label (NOT `transport-close` — the reason string is never classified).
      expect(line).toContain("kind=truncated")
      expect(line).not.toContain("kind=transport-close")
      expect(line).toContain("frames=1")
      expect(line).toContain("last-frame=content_block_start@")
      // The middlebox-idle-reclaim hint is keyed on `kind=transport-close`, so a truncation NEVER carries
      // it even with a thinking-stall-shaped last frame — a clean EOF is not an idle-reclaimed connection.
      expect(line).not.toContain("likely=middlebox-idle-reclaim")
    } finally {
      spy.mockRestore()
    }
  })
})

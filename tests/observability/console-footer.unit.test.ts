/**
 * ConsoleSink active-request **footer** — width awareness + model grouping.
 *
 * The footer (`[<-->] ...`) is the live "in-flight requests" indicator drawn
 * below the log stream. These tests pin the load-bearing invariant introduced
 * by the width-awareness work:
 *
 *   footer is ALWAYS ≤ 1 physical line (display width ≤ columns-1), for any
 *   terminal width, concurrency, or content (including embedded newlines).
 *
 * Plus the multi-request grouping behavior: requests are aggregated by resolved
 * model (`model ×N`), and the number of groups shown is driven by terminal
 * width (not a fixed cap), with overflow collapsed into `+K more`.
 *
 * Determinism: the footer embeds `elapsed = now - startTime`, whose rendered
 * width jitters over time. Tests that assert exact widths freeze the clock via
 * `setSystemTime` and pin `startTime` relative to it.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test"
import stringWidth from "string-width"

import type {
  //
  ObservabilityEvent,
  RequestContextSnapshot,
} from "~/lib/observability"

import { createBus } from "~/lib/observability"
import { ConsoleSink } from "~/lib/observability/sinks/console"

type RequestEvent = Extract<ObservabilityEvent, { kind: `request.${string}` }>

/** Frozen wall-clock for deterministic `elapsed` rendering. */
const NOW = 1_700_000_000_000

const CLEAR_LINE = "\x1b[2K\r"

function makeCapture() {
  const chunks: Array<string> = []
  const stdout = {
    write: (s: string) => (chunks.push(s), true),
    isTTY: true,
  } as unknown as NodeJS.WritableStream
  return { stdout, chunks }
}

interface CtxOpts {
  id: string
  path?: string
  model?: string
  method?: string
  /** ms of elapsed at render time (startTime = NOW - elapsedMs). */
  elapsedMs?: number
}

function makeCtx(o: CtxOpts): RequestContextSnapshot {
  return {
    id: o.id,
    endpoint: "anthropic-messages",
    method: o.method ?? "POST",
    path: o.path ?? "/v1/messages",
    resolvedModel: o.model,
    state: "streaming",
    startTime: NOW - (o.elapsedMs ?? 0),
    queueWaitMs: 0,
  }
}

function created(ctx: RequestContextSnapshot): RequestEvent {
  return { kind: "request.created", ctx }
}

/**
 * Drive N active requests through a sink at a fixed `columns`, then trigger one
 * footer render via a `system.log` line (routes through `printLog` →
 * `renderFooter`). Returns the footer text (CLEAR_LINE prefix stripped) and its
 * display width.
 */
function renderFooter(opts: { contexts: Array<RequestContextSnapshot>; columns: number }): { footer: string; width: number } {
  const cap = makeCapture()
  const bus = createBus()
  const sink = new ConsoleSink(bus, { stdout: cap.stdout, isTTY: true, columns: opts.columns })
  cleanups.push(() => sink.destroy())

  const pub = bus.scope("request")
  for (const ctx of opts.contexts) pub.publish(created(ctx))

  // Trigger a footer render synchronously (avoids the 100ms timer).
  bus.scope("system").publish({ kind: "system.log", logType: "info", message: "tick", time: NOW })

  // The footer is written as a single `CLEAR_LINE + footer` chunk; find the
  // last chunk carrying the active-request marker.
  const footerChunk = [...cap.chunks].reverse().find((c) => c.includes("[<-->]")) ?? ""
  const footer = footerChunk.startsWith(CLEAR_LINE) ? footerChunk.slice(CLEAR_LINE.length) : footerChunk
  // stringWidth strips ANSI (the pc.dim wrap) and counts `…`/CJK correctly.
  return { footer, width: stringWidth(footer) }
}

const cleanups: Array<() => void> = []
beforeEach(() => setSystemTime(new Date(NOW)))
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  setSystemTime()
})

describe("ConsoleSink footer — width awareness", () => {
  test("without truncation the footer would overflow; rendered footer is ≤ columns-1", () => {
    // Many distinct long-named models → a naturally very wide footer.
    const contexts = Array.from({ length: 12 }, (_, i) => makeCtx({ id: `r${i}`, model: `anthropic/claude-very-long-model-name-${i}`, elapsedMs: 5000 }))
    const columns = 60
    const { footer, width } = renderFooter({ contexts, columns })

    // Pre-truncation width (join of all segments) provably exceeds columns.
    const rawWidth = contexts.reduce((n, c) => n + stringWidth(c.resolvedModel ?? ""), 0)
    expect(rawWidth).toBeGreaterThan(columns)

    expect(footer).toContain("[<-->]")
    expect(width).toBeLessThanOrEqual(columns - 1)
  })

  test("boundary: content exactly columns-1 is not truncated (no ellipsis)", () => {
    // Single request; pick columns so the built footer lands at exactly cols-1.
    const ctx = makeCtx({ id: "r1", method: "POST", path: "/v1/messages", model: "m", elapsedMs: 5000 })
    // Inner: "[<-->] POST /v1/messages m 5.0s" — measure its width, set columns = w+1.
    const probe = renderFooter({ contexts: [ctx], columns: 500 })
    const innerWidth = probe.width
    const { footer, width } = renderFooter({ contexts: [ctx], columns: innerWidth + 1 })
    expect(width).toBe(innerWidth) // not truncated: cols-1 === innerWidth
    expect(footer).not.toContain("…")
  })

  test("boundary: content exactly columns is truncated by 1 (ellipsis appears)", () => {
    const ctx = makeCtx({ id: "r1", model: "m", elapsedMs: 5000 })
    const probe = renderFooter({ contexts: [ctx], columns: 500 })
    const innerWidth = probe.width
    // columns == innerWidth → budget innerWidth-1 → must truncate.
    const { footer, width } = renderFooter({ contexts: [ctx], columns: innerWidth })
    expect(width).toBeLessThanOrEqual(innerWidth - 1)
    expect(footer).toContain("…")
  })

  test("single request with over-long path/model is truncated to ≤ columns-1", () => {
    const ctx = makeCtx({
      id: "r1",
      path: "/v1/messages/with/a/really/long/sub/path/segment/that/keeps/going",
      model: "anthropic/claude-opus-with-a-very-long-identifier",
      elapsedMs: 1234,
    })
    const columns = 40
    const { width } = renderFooter({ contexts: [ctx], columns })
    expect(width).toBeLessThanOrEqual(columns - 1)
  })
})

describe("ConsoleSink footer — model grouping", () => {
  test("multi-request groups by model as `model ×N`, no per-request listing", () => {
    const contexts = [
      makeCtx({ id: "a", model: "claude-opus-4-8", elapsedMs: 3000 }),
      makeCtx({ id: "b", model: "claude-opus-4-8", elapsedMs: 5000 }),
      makeCtx({ id: "c", model: "gpt-5", elapsedMs: 1000 }),
    ]
    const { footer } = renderFooter({ contexts, columns: 200 })
    expect(footer).toContain("claude-opus-4-8 ×2")
    expect(footer).toContain("gpt-5 ×1")
    // Not a per-request enumeration: the path should not appear for grouped rows.
    expect(footer).not.toContain("/v1/messages")
  })

  test("groups sorted by descending count", () => {
    const contexts = [
      makeCtx({ id: "a", model: "solo", elapsedMs: 9000 }),
      makeCtx({ id: "b", model: "big", elapsedMs: 1000 }),
      makeCtx({ id: "c", model: "big", elapsedMs: 1000 }),
      makeCtx({ id: "d", model: "big", elapsedMs: 1000 }),
    ]
    const { footer } = renderFooter({ contexts, columns: 200 })
    expect(footer.indexOf("big ×3")).toBeLessThan(footer.indexOf("solo ×1"))
  })

  test("all-same model → single segment with large N", () => {
    const contexts = Array.from({ length: 7 }, (_, i) => makeCtx({ id: `r${i}`, model: "same", elapsedMs: 2000 }))
    const { footer } = renderFooter({ contexts, columns: 200 })
    expect(footer).toContain("same ×7")
  })

  test("width-driven inclusion: narrow width collapses overflow into +K more", () => {
    const contexts = Array.from({ length: 8 }, (_, i) => makeCtx({ id: `r${i}`, model: `model-${i}`, elapsedMs: 2000 }))
    const narrow = renderFooter({ contexts, columns: 40 })
    const wide = renderFooter({ contexts, columns: 200 })

    expect(narrow.footer).toContain("more")
    expect(narrow.width).toBeLessThanOrEqual(40 - 1)
    // Wider terminal shows strictly more groups (fewer collapsed) — K is width-driven, not a fixed 3.
    const narrowK = Number(/\+(\d+) more/.exec(narrow.footer)?.[1] ?? "0")
    const wideK = Number(/\+(\d+) more/.exec(wide.footer)?.[1] ?? "0")
    expect(wideK).toBeLessThan(narrowK)
  })

  test("unresolved model falls into the (resolving) bucket", () => {
    const contexts = [makeCtx({ id: "a", model: undefined, elapsedMs: 1000 }), makeCtx({ id: "b", model: undefined, elapsedMs: 2000 })]
    const { footer } = renderFooter({ contexts, columns: 200 })
    expect(footer).toContain("(resolving) ×2")
  })
})

describe("ConsoleSink footer — control-char / single-line invariant", () => {
  test("embedded newline in model/path never produces a second physical line", () => {
    const ctx = makeCtx({ id: "r1", model: "bad\nmodel", path: "/v1/mes\nsages", elapsedMs: 1000 })
    // Positive sample: the input genuinely carries newlines.
    expect(ctx.resolvedModel).toContain("\n")
    const { footer } = renderFooter({ contexts: [ctx], columns: 200 })
    expect(footer).not.toContain("\n")
    expect(footer).not.toContain("\r")
  })
})

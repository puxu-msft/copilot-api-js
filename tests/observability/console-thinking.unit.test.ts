/**
 * `thinking` observability as a per-request terminal dimension (console).
 *
 * Guards the two behaviors the adversarial review required:
 *  1. `formatThinkingTag` renders `effective` (authoritative) and surfaces a
 *     differing `requested` as `requested→effective`.
 *  2. Multiple `thinking` `feature_applied` events for ONE request (per-attempt,
 *     e.g. a legacy-thinking-retry that flips enabled→adaptive on retry) collapse
 *     to a SINGLE thinking tag at completion — `requested` fixed, `effective`
 *     last-wins — instead of the old contradictory pile-up
 *     `( thinking:enabled, thinking:adaptive )`.
 */

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ObservabilityEvent,
  RequestContextSnapshot,
} from "~/lib/observability"

import { createBus } from "~/lib/observability"
import {
  //
  formatThinkingTag,
  TerminalUi,
} from "~/lib/tui"

/** Request-scoped events (what `bus.scope("request").publish` accepts). */
type RequestEvent = Extract<ObservabilityEvent, { kind: `request.${string}` }>

function makeCtx(id = "ctx-1"): RequestContextSnapshot {
  return { id, endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", state: "executing", startTime: Date.now() - 100, queueWaitMs: 0 }
}

function thinkingEvent(ctx: RequestContextSnapshot, detail: Record<string, unknown>): RequestEvent {
  return { kind: "request.feature_applied", ctx, feature: "thinking", detail }
}

function completedEvent(ctx: RequestContextSnapshot): RequestEvent {
  const completedCtx = { ...ctx, state: "completed" as const }
  return { kind: "request.completed", ctx: completedCtx, entry: { id: ctx.id, endpoint: "anthropic-messages", state: "completed" } as never }
}

function makeCapture() {
  const chunks: Array<string> = []
  const stdout = { write: (s: string) => (chunks.push(s), true), isTTY: false } as unknown as NodeJS.WritableStream
  return { stdout, text: () => chunks.join("") }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

/** Render one request's lifecycle and return the [ OK ] line text. */
function renderLine(events: Array<(ctx: RequestContextSnapshot) => RequestEvent>): string {
  const cap = makeCapture()
  const bus = createBus()
  const sink = new TerminalUi(bus, { stdout: cap.stdout, isTTY: false })
  cleanups.push(() => sink.destroy())
  const ctx = makeCtx()
  const pub = bus.scope("request")
  for (const make of events) pub.publish(make(ctx))
  return cap.text()
}

describe("formatThinkingTag", () => {
  test("equal requested/effective → single value", () => {
    expect(formatThinkingTag({ requested: "adaptive", effective: "adaptive" })).toBe("thinking:adaptive")
  })
  test("differing → requested→effective (coercion visible)", () => {
    expect(formatThinkingTag({ requested: "enabled", effective: "adaptive" })).toBe("thinking:enabled→adaptive")
  })
  test("missing requested → effective only", () => {
    expect(formatThinkingTag({ effective: "adaptive" })).toBe("thinking:adaptive")
  })
})

describe("ConsoleSink — thinking terminal dimension", () => {
  test("no coercion → single thinking:adaptive tag", () => {
    const out = renderLine([(c) => thinkingEvent(c, { requested: "adaptive", effective: "adaptive" }), completedEvent])
    expect(out).toContain("(thinking:adaptive)")
  })

  test("multi-attempt (enabled→adaptive on retry) collapses to ONE tag, not a contradiction", () => {
    const out = renderLine([
      // attempt 0: client enabled, not yet coerced
      (c) => thinkingEvent(c, { requested: "enabled", effective: "enabled" }),
      // attempt 1: legacy-thinking-retry coerced the wire to adaptive (requested stays fixed)
      (c) => thinkingEvent(c, { requested: "enabled", effective: "adaptive" }),
      completedEvent,
    ])
    expect(out).toContain("(thinking:enabled→adaptive)")
    // No contradictory pile-up: the bare per-attempt tags must NOT both appear.
    expect(out).not.toContain("thinking:enabled,")
    expect(out).not.toContain("thinking:adaptive,")
    expect(out).not.toContain(", thinking:")
  })

  test("effective is last-wins; requested survives an event that omits it", () => {
    const out = renderLine([
      (c) => thinkingEvent(c, { requested: "enabled", effective: "enabled" }),
      (c) => thinkingEvent(c, { effective: "adaptive" }), // requested omitted — must be preserved
      completedEvent,
    ])
    expect(out).toContain("(thinking:enabled→adaptive)")
  })
})

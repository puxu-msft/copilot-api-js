/**
 * Keeper: a request that has reached a TERMINAL state must never be re-materialized into the
 * TerminalUi `active` map (footer spinner set) by a LATE `request.*` event. Regression guard for the
 * "TUI 面板永久转圈" bug — a streaming request failed pre-commit (`ctx.fail()` → `request.failed` →
 * `active.delete`), then error-shaping recorded `error-shaping-decided` AFTER the fail, emitting a
 * `request.feature_applied` whose ctx snapshot carries `state:"failed"`; `upsertCtx`'s materialize-
 * on-demand branch resurrected the dead request → it spun forever.
 *
 * Also pins the `isTerminalState` / `ACTIVE_STATES` partition primitive (single source of truth).
 */
import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestLifecycleState } from "~/lib/history/types"
import type {
  //
  ObservabilityEvent,
  RequestContextSnapshot,
} from "~/lib/observability"

import {
  //
  ACTIVE_STATES,
  isActiveState,
  isTerminalState,
} from "~/lib/history/lifecycle-state"
import { createBus } from "~/lib/observability"
import { TerminalUi } from "~/lib/tui"

type RequestEvent = Extract<ObservabilityEvent, { kind: `request.${string}` }>

const REQ_ID = "req-terminal-1"

function makeCtx(state: RequestLifecycleState): RequestContextSnapshot {
  return { id: REQ_ID, endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", state, startTime: Date.now() - 100, queueWaitMs: 0 }
}

function createdEvent(): RequestEvent {
  return { kind: "request.created", ctx: makeCtx("pending") }
}

/** The late feature_applied error-shaping emits AFTER ctx.fail() — ctx snapshot carries a terminal state. */
function lateFeatureApplied(terminalState: RequestLifecycleState): RequestEvent {
  return {
    kind: "request.feature_applied",
    ctx: makeCtx(terminalState),
    feature: "error-shaping-decided",
    detail: { decision: "canonical-error", errorType: "token_limit", commitPhase: "pre-commit" },
  }
}

/** Terminal lifecycle event for a given terminal state (completed/failed/aborted). */
function terminalEvent(terminalState: "completed" | "failed" | "aborted"): RequestEvent {
  const entry = { id: REQ_ID, endpoint: "anthropic-messages", state: terminalState } as never
  if (terminalState === "failed") return { kind: "request.failed", ctx: makeCtx("failed"), entry, error: "prompt is too long", statusCode: 400 }
  if (terminalState === "aborted") return { kind: "request.aborted", ctx: makeCtx("aborted"), entry }
  return { kind: "request.completed", ctx: makeCtx("completed"), entry }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

/** A silent TerminalUi subscribed to a fresh bus; returns the sink + its request publisher. */
function makeSink() {
  const bus = createBus()
  const sink = new TerminalUi(bus, { isTTY: false, silent: true })
  cleanups.push(() => sink.destroy())
  const active = (sink as unknown as { active: Map<string, unknown> }).active
  return { pub: bus.scope("request"), active }
}

describe("isTerminalState / ACTIVE_STATES partition primitive", () => {
  // Exhaustive over RequestLifecycleState —守住单一源正确性 + partition 完备（漏删一个成员即被逮）。
  const ACTIVE: Array<RequestLifecycleState> = ["pending", "executing", "streaming"]
  const TERMINAL: Array<RequestLifecycleState> = ["completed", "failed", "aborted", "interrupted"]

  test("ACTIVE_STATES is exactly the three active states", () => {
    expect(([...ACTIVE_STATES] as Array<string>).sort()).toEqual(([...ACTIVE] as Array<string>).sort())
  })
  for (const s of ACTIVE) {
    test(`${s} → active (not terminal)`, () => {
      expect(isActiveState(s)).toBe(true)
      expect(isTerminalState(s)).toBe(false)
    })
  }
  for (const s of TERMINAL) {
    test(`${s} → terminal (not active)`, () => {
      expect(isTerminalState(s)).toBe(true)
      expect(isActiveState(s)).toBe(false)
    })
  }
})

describe("TerminalUi — terminated request is never resurrected into `active`", () => {
  // Parametrize the full live-reachable terminal set: a late feature_applied after ANY of these
  // must not re-add the request. (`interrupted` is DB-reaper-only, never a live event — omitted.)
  for (const terminalState of ["completed", "failed", "aborted"] as const) {
    test(`late feature_applied after request.${terminalState} does NOT re-add to active`, () => {
      const { pub, active } = makeSink()
      pub.publish(createdEvent()) // pending → materialized
      expect(active.size).toBe(1)
      pub.publish(terminalEvent(terminalState)) // onTerminal → active.delete
      expect(active.size).toBe(0)
      // The bug: this late feature_applied (ctx.state=terminal) re-materialized the dead request.
      pub.publish(lateFeatureApplied(terminalState))
      expect(active.size).toBe(0) // guard holds — no spinner resurrection
    })
  }

  test("late feature_applied for a NEVER-created terminal ctx also does not materialize (pure missing branch + throwaway is usable)", () => {
    const { pub, active } = makeSink()
    // No prior created/terminal — upsertCtx hits the missing branch with a terminal-state ctx.
    // The handler still mutates the returned throwaway (tag push) — must not throw AND must not insert.
    expect(() => pub.publish(lateFeatureApplied("failed"))).not.toThrow()
    expect(active.size).toBe(0)
  })

  // Positive control (guard is state-driven, not blanket-reject): a feature during STREAMING (active
  // state) whose `created` we missed MUST still materialize — otherwise the guard is vacuously true.
  test("feature_applied during streaming (active state) still materializes", () => {
    const { pub, active } = makeSink()
    pub.publish({ kind: "request.feature_applied", ctx: makeCtx("streaming"), feature: "error-shaping-decided" })
    expect(active.size).toBe(1)
  })
})

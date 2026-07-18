import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ObservabilityEvent,
  RequestContextSnapshot,
} from "~/lib/observability"

import { ActiveRequestStore } from "~/lib/tui/active-request-store"
import {
  //
  INITIAL_UI_STATE,
  reconcile,
  reduce,
  selectedIndex,
} from "~/lib/tui/controller"

function ctx(id: string, state: RequestContextSnapshot["state"] = "streaming"): RequestContextSnapshot {
  return { id, endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", state, startTime: 1, queueWaitMs: 0 }
}

function apply(store: ActiveRequestStore, event: ObservabilityEvent) {
  return store.apply(event as Extract<ObservabilityEvent, { kind: `request.${string}` }>)
}

describe("ActiveRequestStore event reducer", () => {
  test("owns stream, attempt, feature, thinking, and recovered-tool projections", () => {
    const store = new ActiveRequestStore()
    apply(store, { kind: "request.created", ctx: ctx("a") })
    apply(store, { kind: "request.stream_progress", ctx: ctx("a"), bytesIn: 12, eventsIn: 3, blockType: "tool_use" })
    apply(store, { kind: "request.attempt_started", ctx: ctx("a"), attempt: { attemptIndex: 0, strategy: "first" } })
    apply(store, {
      kind: "request.attempt_failed",
      ctx: ctx("a"),
      attempt: { attemptIndex: 0, strategy: "first", error: { status: 500, message: "boom", type: "server_error" } },
      willRetry: true,
      nextStrategy: "network-retry",
    })
    apply(store, { kind: "request.feature_applied", ctx: ctx("a"), feature: "thinking", detail: { requested: "enabled", effective: "adaptive" } })
    apply(store, { kind: "request.feature_applied", ctx: ctx("a"), feature: "tool-call-recovered", detail: { tools: ["Bash", "Edit"] } })

    const entry = store.get("a")!
    expect(entry.streamBytesIn).toBe(12)
    expect(entry.streamEventsIn).toBe(3)
    expect(entry.streamBlockType).toBe("tool_use")
    expect(entry.attemptCount).toBe(1)
    expect(entry.attempts).toHaveLength(1)
    expect(entry.attempts[0].error?.message).toBe("boom")
    expect(entry.thinking).toEqual({ requested: "enabled", effective: "adaptive" })
    expect(entry.recoveredToolNames).toEqual(["Bash", "Edit"])
    expect(entry.tags).toContain("tool-call-recovered")
  })

  test("returns terminal display effect and an ordered removal change without resurrecting late events", () => {
    const store = new ActiveRequestStore()
    apply(store, { kind: "request.created", ctx: ctx("a") })
    apply(store, { kind: "request.created", ctx: ctx("b") })
    const change = apply(store, {
      kind: "request.failed",
      ctx: ctx("a", "failed"),
      entry: { id: "a", endpoint: "anthropic-messages", state: "failed" },
      error: "bad",
      statusCode: 400,
    } as never)
    expect(change.previousIds).toEqual(["a", "b"])
    expect(change.activeIds).toEqual(["b"])
    expect(change.removed).toEqual({ id: "a", index: 0 })
    expect(change.effects.map((effect) => effect.kind)).toEqual(["terminal"])
    apply(store, { kind: "request.feature_applied", ctx: ctx("a", "failed"), feature: "error-shaping-decided" })
    expect(store.orderedIds()).toEqual(["b"])
  })
})

describe("ID-based controller reconciliation", () => {
  const context = (activeIds: Array<string>) => ({ activeIds, visibleRows: 2 })

  test("selection truth is an id and index is render-derived", () => {
    let state = reduce(INITIAL_UI_STATE, { kind: "space" }, context(["a", "b", "c"]))
    state = reduce(state, { kind: "down" }, context(["a", "b", "c"]))
    expect(state.selectedRequestId).toBe("b")
    expect(selectedIndex(state, ["a", "b", "c"])).toBe(1)
  })

  test("selected removal chooses next sibling, then previous for the last row", () => {
    const base = { ...INITIAL_UI_STATE, view: "panel" as const, selectedRequestId: "b" }
    const next = reconcile(base, ["a", "c"], { previousIds: ["a", "b", "c"], activeIds: ["a", "c"], removed: { id: "b", index: 1 }, effects: [] }, 2)
    expect(next.selectedRequestId).toBe("c")
    const previous = reconcile(
      { ...base, selectedRequestId: "c" },
      ["a", "b"],
      { previousIds: ["a", "b", "c"], activeIds: ["a", "b"], removed: { id: "c", index: 2 }, effects: [] },
      2,
    )
    expect(previous.selectedRequestId).toBe("b")
  })

  test("sibling removal preserves detail identity; viewed removal converges to panel before render", () => {
    const detail = { ...INITIAL_UI_STATE, view: "detail" as const, selectedRequestId: "b", detailRequestId: "b" }
    const sibling = reconcile(detail, ["b", "c"], { previousIds: ["a", "b", "c"], activeIds: ["b", "c"], removed: { id: "a", index: 0 }, effects: [] }, 2)
    expect(sibling.view).toBe("detail")
    expect(sibling.detailRequestId).toBe("b")
    const viewed = reconcile(detail, ["a", "c"], { previousIds: ["a", "b", "c"], activeIds: ["a", "c"], removed: { id: "b", index: 1 }, effects: [] }, 2)
    expect(viewed.view).toBe("panel")
    expect(viewed.detailRequestId).toBeUndefined()
    expect(viewed.selectedRequestId).toBe("c")
  })
})

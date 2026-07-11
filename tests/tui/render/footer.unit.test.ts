/**
 * `buildActiveFooter` — pure active-request footer builder (extracted from
 * ConsoleSink in the P0 terminal-layer reorg).
 *
 * These are the same load-bearing invariants pinned by
 * `tests/observability/console-footer.unit.test.ts`, but asserted *directly*
 * against the pure function instead of driving them through the sink's event
 * plumbing:
 *
 *   - the footer is ALWAYS ≤ 1 physical line (display width ≤ columns-1), for
 *     any terminal width, concurrency, or content (incl. embedded newlines);
 *   - multi-request rows are grouped by resolved model (`model ×N`), width-
 *     driven, with overflow collapsed into `+K more`;
 *   - an unresolved model falls into the `(resolving)` bucket.
 *
 * Determinism: the footer embeds `elapsed = now - startTime`. Here `now` is an
 * explicit argument (no wall clock), so we pin a frozen `NOW` and derive each
 * request's `startTime` relative to it.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import stringWidth from "string-width"

import type { RequestContextSnapshot } from "~/lib/observability"
import type { ActiveRequestView } from "~/lib/tui/render/footer"

import { buildActiveFooter } from "~/lib/tui/render/footer"

/** Frozen wall-clock for deterministic `elapsed` rendering. */
const NOW = 1_700_000_000_000

interface ViewOpts {
  id: string
  path?: string
  model?: string
  method?: string
  /** ms of elapsed at render time (startTime = NOW - elapsedMs). */
  elapsedMs?: number
  streamBytesIn?: number
  streamEventsIn?: number
  streamBlockType?: string
}

function makeView(o: ViewOpts): ActiveRequestView {
  const ctx: RequestContextSnapshot = {
    id: o.id,
    endpoint: "anthropic-messages",
    method: o.method ?? "POST",
    path: o.path ?? "/v1/messages",
    resolvedModel: o.model,
    state: "streaming",
    startTime: NOW - (o.elapsedMs ?? 0),
    queueWaitMs: 0,
  }
  return {
    ctx,
    streamBytesIn: o.streamBytesIn,
    streamEventsIn: o.streamEventsIn,
    streamBlockType: o.streamBlockType,
  }
}

function build(views: Array<ActiveRequestView>, columns: number): { footer: string; width: number } {
  const footer = buildActiveFooter({ active: views, now: NOW, columns })
  return { footer, width: stringWidth(footer) }
}

describe("buildActiveFooter — empty", () => {
  test("no active requests → empty string", () => {
    expect(buildActiveFooter({ active: [], now: NOW, columns: 80 })).toBe("")
  })
})

describe("buildActiveFooter — width awareness", () => {
  test("without truncation the footer would overflow; rendered footer is ≤ columns-1", () => {
    const views = Array.from({ length: 12 }, (_, i) => makeView({ id: `r${i}`, model: `anthropic/claude-very-long-model-name-${i}`, elapsedMs: 5000 }))
    const columns = 60
    const { footer, width } = build(views, columns)

    // Pre-truncation width (join of all model names) provably exceeds columns.
    const rawWidth = views.reduce((n, v) => n + stringWidth(v.ctx.resolvedModel ?? ""), 0)
    expect(rawWidth).toBeGreaterThan(columns)

    expect(footer).toContain("[<-->]")
    expect(width).toBeLessThanOrEqual(columns - 1)
  })

  test("boundary: content exactly columns-1 is not truncated (no ellipsis)", () => {
    const view = makeView({ id: "r1", method: "POST", path: "/v1/messages", model: "m", elapsedMs: 5000 })
    const probe = build([view], 500)
    const innerWidth = probe.width
    const { footer, width } = build([view], innerWidth + 1)
    expect(width).toBe(innerWidth) // not truncated: cols-1 === innerWidth
    expect(footer).not.toContain("…")
  })

  test("boundary: content exactly columns is truncated by 1 (ellipsis appears)", () => {
    const view = makeView({ id: "r1", model: "m", elapsedMs: 5000 })
    const probe = build([view], 500)
    const innerWidth = probe.width
    const { footer, width } = build([view], innerWidth)
    expect(width).toBeLessThanOrEqual(innerWidth - 1)
    expect(footer).toContain("…")
  })

  test("single request with over-long path/model is truncated to ≤ columns-1", () => {
    const view = makeView({
      id: "r1",
      path: "/v1/messages/with/a/really/long/sub/path/segment/that/keeps/going",
      model: "anthropic/claude-opus-with-a-very-long-identifier",
      elapsedMs: 1234,
    })
    const columns = 40
    const { width } = build([view], columns)
    expect(width).toBeLessThanOrEqual(columns - 1)
  })
})

describe("buildActiveFooter — model grouping", () => {
  test("multi-request groups by model as `model ×N`, no per-request listing", () => {
    const views = [
      makeView({ id: "a", model: "claude-opus-4-8", elapsedMs: 3000 }),
      makeView({ id: "b", model: "claude-opus-4-8", elapsedMs: 5000 }),
      makeView({ id: "c", model: "gpt-5", elapsedMs: 1000 }),
    ]
    const { footer } = build(views, 200)
    expect(footer).toContain("claude-opus-4-8 ×2")
    expect(footer).toContain("gpt-5 ×1")
    expect(footer).not.toContain("/v1/messages")
  })

  test("groups sorted by descending count", () => {
    const views = [
      makeView({ id: "a", model: "solo", elapsedMs: 9000 }),
      makeView({ id: "b", model: "big", elapsedMs: 1000 }),
      makeView({ id: "c", model: "big", elapsedMs: 1000 }),
      makeView({ id: "d", model: "big", elapsedMs: 1000 }),
    ]
    const { footer } = build(views, 200)
    expect(footer.indexOf("big ×3")).toBeLessThan(footer.indexOf("solo ×1"))
  })

  test("all-same model → single segment with large N", () => {
    const views = Array.from({ length: 7 }, (_, i) => makeView({ id: `r${i}`, model: "same", elapsedMs: 2000 }))
    const { footer } = build(views, 200)
    expect(footer).toContain("same ×7")
  })

  test("width-driven inclusion: narrow width collapses overflow into +K more", () => {
    const views = Array.from({ length: 8 }, (_, i) => makeView({ id: `r${i}`, model: `model-${i}`, elapsedMs: 2000 }))
    const narrow = build(views, 40)
    const wide = build(views, 200)

    expect(narrow.footer).toContain("more")
    expect(narrow.width).toBeLessThanOrEqual(40 - 1)
    const narrowK = Number(/\+(\d+) more/.exec(narrow.footer)?.[1] ?? "0")
    const wideK = Number(/\+(\d+) more/.exec(wide.footer)?.[1] ?? "0")
    expect(wideK).toBeLessThan(narrowK)
  })

  test("unresolved model falls into the (resolving) bucket", () => {
    const views = [makeView({ id: "a", model: undefined, elapsedMs: 1000 }), makeView({ id: "b", model: undefined, elapsedMs: 2000 })]
    const { footer } = build(views, 200)
    expect(footer).toContain("(resolving) ×2")
  })

  test("group byte sum shown only when the group has streaming progress", () => {
    const views = [
      makeView({ id: "a", model: "m1", elapsedMs: 3000, streamBytesIn: 1000 }),
      makeView({ id: "b", model: "m1", elapsedMs: 2000, streamBytesIn: 2000 }),
    ]
    const { footer } = build(views, 200)
    // Two requests, summed bytes → downstream marker present.
    expect(footer).toContain("m1 ×2")
    expect(footer).toContain("↓")
  })
})

describe("buildActiveFooter — single request", () => {
  test("single active request renders method/path/model/elapsed inline", () => {
    const view = makeView({ id: "r1", method: "POST", path: "/v1/messages", model: "claude-opus-4-8", elapsedMs: 5000 })
    const { footer } = build([view], 200)
    expect(footer).toContain("[<-->]")
    expect(footer).toContain("POST")
    expect(footer).toContain("/v1/messages")
    expect(footer).toContain("claude-opus-4-8")
  })
})

describe("buildActiveFooter — control-char / single-line invariant", () => {
  test("embedded newline in model/path never produces a second physical line", () => {
    const view = makeView({ id: "r1", model: "bad\nmodel", path: "/v1/mes\nsages", elapsedMs: 1000 })
    expect(view.ctx.resolvedModel).toContain("\n")
    const { footer } = build([view], 200)
    expect(footer).not.toContain("\n")
    expect(footer).not.toContain("\r")
  })
})

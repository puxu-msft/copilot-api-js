/**
 * `buildCollapsedLines` / `buildPanelLines` / `buildDetailLines` — pure P1
 * interactive-TUI line builders (expanded request table + single-request detail
 * view + collapsed one-liner). These pin the load-bearing presentation
 * invariants directly against the pure functions (no sink, no wall clock):
 *
 *   - EVERY produced line has display width ≤ columns-1, for any width, content,
 *     selection, or scroll offset — the same one-physical-line guard the region
 *     renderer depends on (a wider line auto-wraps and corrupts DECSTBM
 *     anchoring). A positive sample first proves the un-truncated content would
 *     overflow, so the assertion is not vacuous.
 *   - the selected panel row is wrapped in literal reverse-video (`\x1b[7m` …
 *     `\x1b[27m`) — literal, not `pc.inverse`, so the marker survives the
 *     non-TTY test environment where picocolors emits no codes.
 *   - the visible window is `active.slice(scrollOffset, scrollOffset + rows)`
 *     (minus one row when `showHelp` reserves the keybar) — the selected row,
 *     when inside the window, appears reversed at its window-relative position.
 *   - the detail view surfaces the full request context including per-attempt
 *     diagnostics (strategy / error) — the richest-data-flow contract: detail
 *     consumes complete `attempts[]`, never a collapsed `attemptCount`.
 *
 * Determinism: `elapsed = now - startTime`; `now` is an explicit frozen `NOW`.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import stringWidth from "string-width"

import type { RequestContextSnapshot } from "~/lib/observability"
import type { AttemptSnapshot } from "~/lib/observability"
import type { ActiveRequestView } from "~/lib/tui/render/footer"
import type { DetailView } from "~/lib/tui/render/panel"

import {
  //
  buildCollapsedLines,
  buildDetailLines,
  buildPanelLines,
  MAX_PANEL_ROWS,
  panelContentRows,
} from "~/lib/tui/render/panel"

/** Frozen wall-clock for deterministic `elapsed` rendering. */
const NOW = 1_700_000_000_000

/** Literal reverse-video wrappers the selected row must carry. */
const REVERSE_ON = "\x1b[7m"
const REVERSE_OFF = "\x1b[27m"

interface ViewOpts {
  id: string
  path?: string
  method?: string
  clientModel?: string
  model?: string
  multiplier?: number
  state?: RequestContextSnapshot["state"]
  queueWaitMs?: number
  requestBodySize?: number
  elapsedMs?: number
  streamBytesIn?: number
  streamEventsIn?: number
  streamBlockType?: string
  tags?: Array<string>
  thinking?: { requested?: string; effective: string }
  attempts?: Array<AttemptSnapshot>
}

function makeCtx(o: ViewOpts): RequestContextSnapshot {
  return {
    id: o.id,
    endpoint: "anthropic-messages",
    method: o.method ?? "POST",
    path: o.path ?? "/v1/messages",
    clientModel: o.clientModel,
    resolvedModel: o.model,
    multiplier: o.multiplier,
    state: o.state ?? "streaming",
    startTime: NOW - (o.elapsedMs ?? 0),
    queueWaitMs: o.queueWaitMs ?? 0,
    requestBodySize: o.requestBodySize,
  }
}

function makeView(o: ViewOpts): ActiveRequestView {
  return {
    ctx: makeCtx(o),
    streamBytesIn: o.streamBytesIn,
    streamEventsIn: o.streamEventsIn,
    streamBlockType: o.streamBlockType,
  }
}

function makeDetail(o: ViewOpts): DetailView {
  return {
    ...makeView(o),
    tags: o.tags,
    thinking: o.thinking,
    attempts: o.attempts,
  }
}

/** Assert every line in a region fits one physical line at the given width. */
function expectAllFit(lines: ReadonlyArray<string>, columns: number): void {
  for (const line of lines) {
    expect(stringWidth(line)).toBeLessThanOrEqual(columns - 1)
  }
}

// ============================================================================
// buildCollapsedLines
// ============================================================================

describe("buildCollapsedLines", () => {
  test("returns a single-element array (Region N=1)", () => {
    const lines = buildCollapsedLines({ active: [makeView({ id: "r1", elapsedMs: 1000 })], now: NOW, columns: 80, showHelp: false })
    expect(lines).toHaveLength(1)
  })

  test("carries the footer content plus the minimal expand hint, ≤ columns-1", () => {
    const columns = 80
    const lines = buildCollapsedLines({ active: [makeView({ id: "r1", model: "claude-opus-4-8", elapsedMs: 5000 })], now: NOW, columns, showHelp: false })
    expect(lines[0]).toContain("claude-opus-4-8")
    expect(lines[0]).toContain("expand")
    expectAllFit(lines, columns)
  })

  test("showHelp yields a richer keybar than the minimal default", () => {
    const active = [makeView({ id: "r1", elapsedMs: 1000 })]
    const minimal = buildCollapsedLines({ active, now: NOW, columns: 120, showHelp: false })
    const helped = buildCollapsedLines({ active, now: NOW, columns: 120, showHelp: true })
    expect(stringWidth(helped[0])).toBeGreaterThan(stringWidth(minimal[0]))
  })

  test("empty active still renders the hint line, ≤ columns-1", () => {
    const columns = 40
    const lines = buildCollapsedLines({ active: [], now: NOW, columns, showHelp: false })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("expand")
    expectAllFit(lines, columns)
  })

  test("narrow width keeps the line ≤ columns-1 (footer budget reserves keybar)", () => {
    const columns = 40
    const lines = buildCollapsedLines({
      active: [makeView({ id: "r1", model: "anthropic/claude-opus-with-a-very-long-identifier", path: "/v1/messages/very/long/sub/path", elapsedMs: 5000 })],
      now: NOW,
      columns,
      showHelp: true,
    })
    expectAllFit(lines, columns)
  })
})

// ============================================================================
// buildPanelLines
// ============================================================================

function panelViews(n: number): Array<DetailView> {
  return Array.from({ length: n }, (_, i) =>
    makeDetail({
      id: `req-${String(i).padStart(4, "0")}-abcd`,
      model: `model-${i}`,
      method: "POST",
      path: `/v1/messages/${i}`,
      elapsedMs: 1000 + i * 100,
      requestBodySize: 2048,
      streamBytesIn: 4096,
      streamEventsIn: 10 + i,
      tags: i % 2 === 0 ? ["truncated"] : [],
    }),
  )
}

describe("buildPanelLines", () => {
  test("caps the panel at MAX_PANEL_ROWS with a bidirectional overflow indicator", () => {
    const columns = 80
    // 5 active, generous rows: still capped — 2 content rows + 1 `↑0 ↓3 more`.
    const lines = buildPanelLines({ active: panelViews(5), now: NOW, columns, selectedIndex: 0, scrollOffset: 0, rows: 10, showHelp: false })
    expect(lines.length).toBeLessThanOrEqual(MAX_PANEL_ROWS)
    expect(lines.at(-1)).toContain("more") // overflow indicator (list longer than the window)
    expect(lines.at(-1)).toContain("↓3")
    expectAllFit(lines, columns)
  })

  test("shows every row (no indicator) when the list fits the cap", () => {
    const columns = 80
    const lines = buildPanelLines({ active: panelViews(3), now: NOW, columns, selectedIndex: 1, scrollOffset: 0, rows: 10, showHelp: false })
    expect(lines.length).toBe(3)
    expect(lines.some((l) => l.includes("more"))).toBe(false)
    expect(lines[1]).toContain(REVERSE_ON)
    expect(lines[1]).toContain(REVERSE_OFF)
    expect(lines[0]).not.toContain(REVERSE_ON)
    expectAllFit(lines, columns)
  })

  test("rows render the full request id (not a leading prefix slice)", () => {
    // Real ids look like `req_<ts>_<seq>` where the DISTINGUISHING part is the
    // trailing `_<seq>` — a leading slice would show only the shared prefix.
    // The id sits at the row head so truncateToWidth (tail-trim) never eats it.
    const columns = 120
    const [line] = buildPanelLines({
      active: [makeDetail({ id: "req_1783706112773_1180", model: "m", elapsedMs: 1000 })],
      now: NOW,
      columns,
      selectedIndex: -1,
      scrollOffset: 0,
      rows: 10,
      showHelp: false,
    })
    expect(line).toContain("req_1783706112773_1180")
  })

  test("scrollOffset selects the visible window; indicator counts both sides; selected row reversed", () => {
    const columns = 80
    const active = panelViews(10)
    // 10 active, rows 10 → capped to 3, overflow → 2 content rows + 1 indicator.
    // Scrolled to offset 3: window is active[3..5), selected index 4 = window row 1.
    const lines = buildPanelLines({ active, now: NOW, columns, selectedIndex: 4, scrollOffset: 3, rows: 10, showHelp: false })
    expect(lines.length).toBe(3)
    expect(lines[0]).toContain("req-0003")
    expect(lines[1]).toContain("req-0004")
    expect(lines[1]).toContain(REVERSE_ON) // selected (global 4 = window row 1)
    expect(lines[0]).not.toContain(REVERSE_ON)
    // Indicator: 3 hidden above (0,1,2), 5 hidden below (5..9).
    expect(lines[2]).toContain("↑3 ↓5 more")
    expectAllFit(lines, columns)
  })

  test("an over-long path row is truncated (positive: un-truncated would overflow)", () => {
    const columns = 40
    const view = makeDetail({
      id: "req-9999-xxxx",
      model: "anthropic/claude-opus-with-a-very-long-identifier",
      path: "/v1/messages/with/a/really/long/sub/path/segment/that/keeps/going/and/going",
      elapsedMs: 1234,
      streamBytesIn: 999_999,
      streamEventsIn: 4242,
      tags: ["truncated", "beta-stripped", "thinking"],
    })
    const lines = buildPanelLines({ active: [view], now: NOW, columns, selectedIndex: 0, scrollOffset: 0, rows: 10, showHelp: false })
    // Positive control: the raw row content provably exceeds the budget.
    const rawWidth = stringWidth(`${view.ctx.id} ${view.ctx.resolvedModel} ${view.ctx.method} ${view.ctx.path}`)
    expect(rawWidth).toBeGreaterThan(columns - 1)
    expectAllFit(lines, columns)
  })

  test("showHelp keeps the keybar as the last line, whole panel within MAX_PANEL_ROWS", () => {
    const columns = 80
    const active = panelViews(6)
    const lines = buildPanelLines({ active, now: NOW, columns, selectedIndex: 0, scrollOffset: 0, rows: 10, showHelp: true })
    // Capped: content + overflow indicator + keybar all within MAX_PANEL_ROWS.
    expect(lines.length).toBeLessThanOrEqual(MAX_PANEL_ROWS)
    const keybar = lines.at(-1)
    expect(keybar).toContain("nav")
    expect(keybar).toContain("detail")
    expect(keybar).toContain("quit")
    expectAllFit(lines, columns)
  })
})

describe("panelContentRows (fixed-height contract — kills geometry-churn blank lines)", () => {
  test("never exceeds MAX_PANEL_ROWS and is always ≥ 1", () => {
    for (const total of [1, 3, 10, 40]) {
      for (const active of [0, 1, 3, 5, 50]) {
        for (const showHelp of [false, true]) {
          const n = panelContentRows(total, active, showHelp)
          expect(n).toBeGreaterThanOrEqual(1)
          expect(n).toBeLessThanOrEqual(MAX_PANEL_ROWS)
          expect(n).toBeLessThanOrEqual(total)
        }
      }
    }
  })

  test("is STABLE across active-count changes once the list overflows (the churn fix)", () => {
    // The blank-line root cause: panel height changing with the in-flight count.
    // Once the list is longer than the window, the content row count is constant
    // regardless of how many more requests arrive → the Region never re-anchors.
    const a = panelContentRows(24, 5, false)
    const b = panelContentRows(24, 20, false)
    const c = panelContentRows(24, 200, false)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  test("reserves a row for the overflow indicator only when the list overflows", () => {
    // 3 active, generous rows, no help → all 3 fit, no indicator reservation.
    expect(panelContentRows(10, 3, false)).toBe(3)
    // 4 active → overflows the cap of 3 → one row yields to the indicator.
    expect(panelContentRows(10, 4, false)).toBe(2)
  })
})

// ============================================================================
// buildDetailLines
// ============================================================================

describe("buildDetailLines", () => {
  const entry = makeDetail({
    id: "abcd1234-5678-90ab-cdef",
    method: "POST",
    path: "/v1/messages",
    clientModel: "claude-sonnet-4-5",
    model: "claude-opus-4-8",
    multiplier: 5,
    state: "streaming",
    queueWaitMs: 250,
    requestBodySize: 4096,
    elapsedMs: 8000,
    streamBytesIn: 12_345,
    streamEventsIn: 42,
    streamBlockType: "thinking",
    tags: ["truncated", "thinking"],
    thinking: { requested: "enabled", effective: "adaptive" },
    attempts: [
      { attemptIndex: 0, strategy: "responses", error: { status: 400, message: "thinking cannot be modified", type: "invalid_request_error" } },
      { attemptIndex: 1, strategy: "chat-completions" },
    ],
  })

  test("surfaces req_id, method+path, and client→resolved model", () => {
    const lines = buildDetailLines({ entry, now: NOW, columns: 120 })
    const blob = lines.join("\n")
    expect(blob).toContain("abcd1234-5678-90ab-cdef")
    expect(blob).toContain("POST")
    expect(blob).toContain("/v1/messages")
    expect(blob).toContain("claude-sonnet-4-5")
    expect(blob).toContain("claude-opus-4-8")
  })

  test("renders thinking as requested → effective", () => {
    const lines = buildDetailLines({ entry, now: NOW, columns: 120 })
    const blob = lines.join("\n")
    expect(blob).toContain("enabled")
    expect(blob).toContain("effective")
    expect(blob).toContain("adaptive")
    expect(blob).toContain("→")
  })

  test("renders full per-attempt diagnostics (strategy + error), not just a count", () => {
    const lines = buildDetailLines({ entry, now: NOW, columns: 120 })
    const blob = lines.join("\n")
    expect(blob).toContain("responses")
    expect(blob).toContain("chat-completions")
    expect(blob).toContain("400")
    expect(blob).toContain("thinking cannot be modified")
  })

  test("every detail line is ≤ columns-1 (positive: an attempt line would overflow un-truncated)", () => {
    const columns = 40
    const longError = "a very long upstream error message that definitely exceeds the narrow column budget by a wide margin"
    const narrow = makeDetail({
      id: "abcd1234-5678-90ab-cdef",
      model: "claude-opus-4-8",
      elapsedMs: 1000,
      attempts: [{ attemptIndex: 0, strategy: "responses", error: { status: 400, message: longError, type: "invalid_request_error" } }],
    })
    expect(stringWidth(longError)).toBeGreaterThan(columns - 1)
    const lines = buildDetailLines({ entry: narrow, now: NOW, columns })
    expectAllFit(lines, columns)
  })
})

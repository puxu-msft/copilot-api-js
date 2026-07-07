import {
  //
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { HistoryEntry } from "@/types"

import { SystemSegment } from "@/components/detail/segments/SystemSegment"

/**
 * Build an entry with fine control over both legs. `effective: undefined` omits
 * the effective-source leg entirely (no rewrite leg); `effective: { system: undefined }`
 * models a leg that EXISTS but dropped the system (a removed rewrite).
 */
function makeEntry(opts: { inboundSystem?: unknown; effective?: { system?: unknown } }): HistoryEntry {
  return {
    id: "r1",
    startedAt: 0,
    endpoint: "anthropic-messages",
    clientRequest: { messages: [], system: opts.inboundSystem },
    ...(opts.effective === undefined ? {} : { attempts: [{ index: 0, durationMs: 0, effectiveSource: { messages: [], system: opts.effective.system } }] }),
  } as unknown as HistoryEntry
}

describe("SystemSegment", () => {
  beforeEach(() => {
    // jsdom does not implement scrollIntoView (useAnchorScroll calls it on TOC click).
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders the string system prompt in the rendered view by default, with a Rendered/Raw toggle", () => {
    render(<SystemSegment entry={makeEntry({ inboundSystem: "you are a helpful assistant" })} />)
    expect(screen.getByText(/you are a helpful assistant/)).toBeDefined()
    expect(screen.getByText("Rendered")).toBeDefined()
    expect(screen.getByText("Raw body")).toBeDefined()
  })

  it("renders array system with cache_control in its richest form (cached indicator + labels)", () => {
    const system = [
      { type: "text", text: "block A body" },
      { type: "text", text: "block B body", cache_control: { type: "ephemeral" } },
    ]
    render(<SystemSegment entry={makeEntry({ inboundSystem: system })} />)
    expect(screen.getByText("cached")).toBeDefined()
    expect(screen.getByText("[cache: ephemeral]")).toBeDefined()
    // Multi-block → text appears in both the content pane and the TOC label (M1).
    expect(screen.getAllByText(/block A body/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/block B body/).length).toBeGreaterThan(0)
  })

  it("shows a modified rewrite toggle when inbound and effective systems differ", () => {
    render(<SystemSegment entry={makeEntry({ inboundSystem: "old system text", effective: { system: "new system text" } })} />)
    expect(screen.getByText("modified")).toBeDefined()
    expect(screen.getByText("Original")).toBeDefined()
    expect(screen.getByText("Rewritten")).toBeDefined()
    expect(screen.getByText("Diff")).toBeDefined()
  })

  it("marks the system as removed when an effective leg exists but carries no system", () => {
    // H1: effective leg present, system dropped → "removed", not silently "no rewrite".
    render(<SystemSegment entry={makeEntry({ inboundSystem: "inbound only system", effective: { system: undefined } })} />)
    expect(screen.getByText("removed")).toBeDefined()
    // The rewrite (removal) still exposes the view toggle.
    expect(screen.getByText("Diff")).toBeDefined()
    // Original content stays visible in the default original view.
    expect(screen.getByText(/inbound only system/)).toBeDefined()
  })

  it("marks the system as added and shows the injected system immediately (opens on Rewritten)", () => {
    // H1: inbound had no system, effective injected one → "added", not the empty placeholder.
    render(<SystemSegment entry={makeEntry({ inboundSystem: undefined, effective: { system: "injected system" } })} />)
    expect(screen.getByText("added")).toBeDefined()
    expect(screen.queryByText(/无 system prompt/)).toBeNull()
    // Added opens on Rewritten (empty original), so the injected system is visible up front.
    expect(screen.getByText(/injected system/)).toBeDefined()
  })

  it("marks a present-but-empty inbound system removed by a rewrite as removed, not unchanged", () => {
    // H1 edge: inbound "" and the dropped effective both project to "" text; presence
    // differs, so this is a removal, not the text-equal 'unchanged'.
    render(<SystemSegment entry={makeEntry({ inboundSystem: "", effective: { system: undefined } })} />)
    expect(screen.getByText("removed")).toBeDefined()
    expect(screen.queryByText("rewritten")).toBeNull()
  })

  it("Raw body shows the untouched system JSON (block structure + cache_control)", () => {
    const system = [{ type: "text", text: "raw sys body", cache_control: { type: "ephemeral" } }]
    const { container } = render(<SystemSegment entry={makeEntry({ inboundSystem: system })} />)
    fireEvent.click(screen.getByText("Raw body"))
    // shiki may split tokens across spans, so assert against aggregated textContent.
    const text = container.textContent
    expect(text).toContain("cache_control")
    expect(text).toContain("ephemeral")
    expect(text).toContain("raw sys body")
  })

  it("Raw body falls back to the effective system when inbound had none (added case)", () => {
    const { container } = render(<SystemSegment entry={makeEntry({ inboundSystem: undefined, effective: { system: "effective raw body" } })} />)
    fireEvent.click(screen.getByText("Raw body"))
    expect(container.textContent).toContain("effective raw body")
  })

  it("shows a placeholder and no toggle when neither leg has a system", () => {
    render(<SystemSegment entry={makeEntry({})} />)
    expect(screen.getByText(/无 system prompt/)).toBeDefined()
    expect(screen.queryByText("Rendered")).toBeNull()
    expect(screen.queryByText("Raw body")).toBeNull()
  })

  it("shows a TOC with per-block anchors for a multi-block system (M1)", () => {
    const system = [
      { type: "text", text: "first block alpha" },
      { type: "text", text: "second block beta" },
    ]
    render(<SystemSegment entry={makeEntry({ inboundSystem: system })} />)
    // TocSidebar renders a <nav>; block anchors match systemBlockAnchorId (system-blk-i).
    expect(document.querySelector("nav")).not.toBeNull()
    expect(document.querySelector("#system-blk-0")).not.toBeNull()
    expect(document.querySelector("#system-blk-1")).not.toBeNull()
    // TOC labels lead with text[i] (also appears in the content pane's block labels).
    expect(screen.getAllByText(/text\[0\]/).length).toBeGreaterThan(0)
  })

  it("shows no TOC for a single string system", () => {
    render(<SystemSegment entry={makeEntry({ inboundSystem: "single string system" })} />)
    expect(document.querySelector("nav")).toBeNull()
  })

  it("hides the TOC when the system view switches away from original (H2: anchors are original-only)", () => {
    const system = [
      { type: "text", text: "first block alpha" },
      { type: "text", text: "second block beta" },
    ]
    // A rewrite makes the Original/Rewritten/Diff toggle appear.
    render(<SystemSegment entry={makeEntry({ inboundSystem: system, effective: { system: [{ type: "text", text: "rewritten single" }] } })} />)
    // Original view: TOC present.
    expect(document.querySelector("nav")).not.toBeNull()
    // Diff view: TOC gone (its block anchors don't exist there).
    fireEvent.click(screen.getByText("Diff"))
    expect(document.querySelector("nav")).toBeNull()
    // Back to Original: TOC returns.
    fireEvent.click(screen.getByText("Original"))
    expect(document.querySelector("nav")).not.toBeNull()
  })

  it("clicking a TOC node scrolls to its block anchor", () => {
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy
    const system = [
      { type: "text", text: "alpha block" },
      { type: "text", text: "beta block" },
    ]
    render(<SystemSegment entry={makeEntry({ inboundSystem: system })} />)
    // The TOC label (first match, in the <nav>) is the clickable node.
    fireEvent.click(screen.getAllByText(/text\[1\]/)[0])
    expect(scrollSpy).toHaveBeenCalled()
  })
})

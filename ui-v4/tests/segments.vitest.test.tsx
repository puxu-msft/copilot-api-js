import {
  //
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import {
  //
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { HistoryEntry } from "@/types"

import { ConvoSegment } from "@/components/detail/segments/ConvoSegment"
import { HeadersSegment } from "@/components/detail/segments/HeadersSegment"
import { MetaSegment } from "@/components/detail/segments/MetaSegment"
import { StagesSegment } from "@/components/detail/segments/StagesSegment"

const base = {
  id: "r1",
  startedAt: 0,
  endpoint: "anthropic-messages",
  clientRequest: { messages: [{ role: "user", content: "convo hello" }] },
} as unknown as HistoryEntry

describe("detail segments", () => {
  const scrollIntoView = vi.fn()
  beforeEach(() => {
    // jsdom lacks scrollIntoView — useAnchorScroll calls it on TOC node click.
    scrollIntoView.mockClear()
    Element.prototype.scrollIntoView = scrollIntoView
  })
  it("ConvoSegment renders inbound conversation", () => {
    render(<ConvoSegment entry={base} />)
    // "convo hello" appears in both the TOC label and the content body.
    expect(screen.getAllByText(/convo hello/).length).toBeGreaterThan(0)
  })
  it("StagesSegment shows Inbound leg label", () => {
    render(<StagesSegment entry={base} />)
    // Selected-leg header carries the full leg label.
    expect(screen.getAllByText(/Inbound \(client → proxy\)/).length).toBeGreaterThan(0)
  })
  it("StagesSegment shows ONLY the first (Inbound) leg by default, not all three at once", () => {
    const e = {
      ...base,
      attempts: [
        {
          index: 0,
          durationMs: 0,
          effectiveSource: { messages: [{ role: "user", content: "eff hello" }] },
          upstreamRequest: { messages: [{ role: "user", content: "wire hello" }] },
        },
      ],
    } as unknown as HistoryEntry
    render(<StagesSegment entry={e} />)
    // Inbound content rendered; Effective/Wire content NOT both rendered simultaneously.
    expect(screen.getByText(/convo hello/)).toBeDefined()
    expect(screen.queryByText(/eff hello/)).toBeNull()
    expect(screen.queryByText(/wire hello/)).toBeNull()
    // Only the selected leg's anchor is in the DOM.
    expect(document.querySelector("#stage-inbound")).not.toBeNull()
    expect(document.querySelector("#stage-effective")).toBeNull()
    expect(document.querySelector("#stage-wire")).toBeNull()
  })
  it("StagesSegment TOC has all three leg nodes + message anchors for the selected leg", () => {
    const e = {
      ...base,
      attempts: [
        {
          index: 0,
          durationMs: 0,
          effectiveSource: { messages: [{ role: "user", content: "eff hello" }] },
          upstreamRequest: { messages: [{ role: "user", content: "wire hello" }] },
        },
      ],
    } as unknown as HistoryEntry
    render(<StagesSegment entry={e} />)
    // 3 leg nodes in the TOC (short labels).
    expect(screen.getByText("Inbound")).toBeDefined()
    expect(screen.getByText("Effective")).toBeDefined()
    expect(screen.getByText("Wire")).toBeDefined()
    // The selected (inbound) leg renders its anchors.
    expect(document.querySelector("#stage-inbound")).not.toBeNull()
    expect(document.querySelector("#stage-inbound-msg-0")).not.toBeNull()
  })
  it("StagesSegment switches the content to the Effective leg when its TOC node is clicked", () => {
    const e = {
      ...base,
      attempts: [
        {
          index: 0,
          durationMs: 0,
          effectiveSource: { messages: [{ role: "user", content: "eff hello" }] },
          upstreamRequest: { messages: [{ role: "user", content: "wire hello" }] },
        },
      ],
    } as unknown as HistoryEntry
    render(<StagesSegment entry={e} />)
    // Initially Inbound is shown.
    expect(screen.getByText(/convo hello/)).toBeDefined()
    expect(screen.queryByText(/eff hello/)).toBeNull()
    fireEvent.click(screen.getByText("Effective"))
    // Now Effective is shown, Inbound content gone.
    expect(screen.getByText(/eff hello/)).toBeDefined()
    expect(screen.queryByText(/convo hello/)).toBeNull()
    expect(document.querySelector("#stage-effective")).not.toBeNull()
    expect(document.querySelector("#stage-inbound")).toBeNull()
  })
  it("StagesSegment Rendered/Raw toggle shows the selected leg's raw JSON body", () => {
    const e = {
      ...base,
      attempts: [{ index: 0, durationMs: 0, effectiveSource: { messages: [{ role: "user", content: "eff hello" }] } }],
    } as unknown as HistoryEntry
    render(<StagesSegment entry={e} />)
    // Rendered (default): conversation body.
    expect(screen.getByText(/convo hello/)).toBeDefined()
    fireEvent.click(screen.getByText("Raw"))
    // Raw view: the inbound raw body JSON renders (CodeBlock). The endpoint field appears.
    expect(screen.getAllByText(/messages/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText("Rendered"))
    expect(screen.getByText(/convo hello/)).toBeDefined()
  })
  it("StagesSegment marks rewritten messages and leaves unchanged ones unmarked", () => {
    const e = {
      ...base,
      clientRequest: {
        messages: [
          { role: "user", content: "keep me" },
          { role: "assistant", content: "original text" },
        ],
      },
      attempts: [
        {
          index: 0,
          durationMs: 0,
          effectiveSource: {
            messages: [
              { role: "user", content: "keep me" },
              { role: "assistant", content: "rewritten text" },
            ],
          },
        },
      ],
    } as unknown as HistoryEntry
    render(<StagesSegment entry={e} />)
    // Switch to Effective leg where the modified mark lives.
    fireEvent.click(screen.getByText("Effective"))
    // The modified message carries a "rewritten" badge (amber).
    const badges = screen.getAllByText(/^rewritten$/)
    expect(badges.length).toBe(1)
    // Unchanged message ("keep me") is not marked — only one badge total.
    expect(badges[0].style.color).toContain("--color-warn")
  })
  it("StagesSegment keeps the inbound↔effective full-diff toggle", () => {
    const e = {
      ...base,
      attempts: [{ index: 0, durationMs: 0, effectiveSource: { messages: [{ role: "user", content: "eff hello" }] } }],
    } as unknown as HistoryEntry
    render(<StagesSegment entry={e} />)
    const diffBtn = screen.getByText(/show full diff/)
    expect(diffBtn).toBeDefined()
    fireEvent.click(diffBtn)
    expect(screen.getByText(/Inbound ↔ Effective diff/)).toBeDefined()
  })
  it("HeadersSegment shows a header key/leg", () => {
    const e = { ...base, clientRequest: { headers: { "x-test": "v1" } } } as HistoryEntry
    render(<HeadersSegment entry={e} />)
    expect(screen.getByText(/x-test/)).toBeDefined()
  })
  it("MetaSegment shows strategy + warnings", () => {
    const e = {
      ...base,
      attempts: [{ index: 0, durationMs: 0, strategy: "network-retry" }],
      warningMessages: [{ code: "W1", message: "careful" }],
    } as HistoryEntry
    render(<MetaSegment entry={e} />)
    expect(screen.getByText(/network-retry/)).toBeDefined()
    expect(screen.getByText(/careful/)).toBeDefined()
  })
})

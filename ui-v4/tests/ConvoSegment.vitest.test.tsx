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

import { ConvoSegment } from "@/components/detail/segments/ConvoSegment"

const entry = {
  id: "r1",
  startedAt: 0,
  endpoint: "anthropic-messages",
  clientRequest: {
    model: "claude-opus-4.8",
    max_tokens: 4096,
    messages: [
      { role: "user", content: "first hello" },
      { role: "assistant", content: [{ type: "text", text: "second hi" }] },
    ],
  },
} as unknown as HistoryEntry

describe("ConvoSegment", () => {
  beforeEach(() => {
    // jsdom does not implement scrollIntoView.
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders the TOC tree with message-level labels", () => {
    render(<ConvoSegment entry={entry} />)
    expect(screen.getByText(/user: first hello/)).toBeDefined()
    expect(screen.getByText(/assistant: second hi/)).toBeDefined()
  })

  it("renders DOM anchors matching the buildMessageTocNodes contract", () => {
    render(<ConvoSegment entry={entry} />)
    // Message wrapper ids.
    expect(document.querySelector("#convo-msg-0")).not.toBeNull()
    expect(document.querySelector("#convo-msg-1")).not.toBeNull()
    // Block wrapper ids (j indexes normalizeToContentBlocks).
    expect(document.querySelector("#convo-msg-0-blk-0")).not.toBeNull()
    expect(document.querySelector("#convo-msg-1-blk-0")).not.toBeNull()
  })

  it("clicking a TOC node scrolls to its anchor", () => {
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy
    render(<ConvoSegment entry={entry} />)
    fireEvent.click(screen.getByText(/assistant: second hi/))
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect(scrollSpy).toHaveBeenCalledWith({ block: "start", behavior: "smooth" })
  })

  it("highlights the clicked node (activeAnchor) after selection", () => {
    render(<ConvoSegment entry={entry} />)
    fireEvent.click(screen.getByText(/assistant: second hi/))
    const activeRow = screen.getByText(/assistant: second hi/).closest("div")
    expect(activeRow?.className).toContain("text-[var(--content-accent)]")
  })

  it("no messages → no TOC nav, just the 无消息 placeholder", () => {
    const empty = { ...entry, clientRequest: { messages: [] } } as unknown as HistoryEntry
    const { container } = render(<ConvoSegment entry={empty} />)
    expect(container.querySelector("nav")).toBeNull()
    expect(screen.getByText(/无消息/)).toBeDefined()
  })

  it("renders the Rendered / Raw body toggle, defaulting to rendered", () => {
    render(<ConvoSegment entry={entry} />)
    expect(screen.getByText("Rendered")).toBeDefined()
    expect(screen.getByText("Raw body")).toBeDefined()
    // Rendered (default): the conversation + TOC are visible.
    expect(screen.getByText(/user: first hello/)).toBeDefined()
    expect(document.querySelector("nav")).not.toBeNull()
  })

  it("Raw body shows the messages JSON (not request-level fields) and hides the TOC + conversation", () => {
    const { container } = render(<ConvoSegment entry={entry} />)
    fireEvent.click(screen.getByText("Raw body"))

    // Raw is the messages array only; request-level fields live under Stages → Inbound.
    // shiki may split tokens across spans, so assert against aggregated textContent.
    const text = container.textContent
    expect(text).toContain("first hello")
    expect(text).not.toContain("max_tokens")
    expect(text).not.toContain("claude-opus-4.8")

    // A hint points to where the full request body lives (M2).
    expect(screen.getByText(/完整请求 body.*见 Stages/)).toBeDefined()

    // The rendered conversation + TOC nav are hidden in raw mode.
    expect(screen.queryByText(/user: first hello/)).toBeNull()
    expect(document.querySelector("nav")).toBeNull()
  })

  it("does not render the system prompt — it now lives in the System segment", () => {
    const withSystem = {
      ...entry,
      clientRequest: { ...(entry.clientRequest as object), system: "SYSTEM_PROMPT_MARKER" },
    } as unknown as HistoryEntry
    const { container } = render(<ConvoSegment entry={withSystem} />)
    // Rendered view (default) shows only message turns — no system payload.
    expect(container.textContent).not.toContain("SYSTEM_PROMPT_MARKER")
  })

  it("toggling back to Rendered restores the conversation view", () => {
    render(<ConvoSegment entry={entry} />)
    fireEvent.click(screen.getByText("Raw body"))
    fireEvent.click(screen.getByText("Rendered"))
    expect(screen.getByText(/user: first hello/)).toBeDefined()
    expect(document.querySelector("nav")).not.toBeNull()
  })
})

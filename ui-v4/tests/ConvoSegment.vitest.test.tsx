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
  inboundRequest: {
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
    expect(activeRow?.className).toContain("text-[var(--color-primary)]")
  })

  it("no messages → no TOC nav, just the 无消息 placeholder", () => {
    const empty = { ...entry, inboundRequest: { messages: [] } } as unknown as HistoryEntry
    const { container } = render(<ConvoSegment entry={empty} />)
    expect(container.querySelector("nav")).toBeNull()
    expect(screen.getByText(/无消息/)).toBeDefined()
  })
})

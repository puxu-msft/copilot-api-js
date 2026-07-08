import {
  //
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

import type { MessageContent } from "@/lib/content/types"
import type { HistoryEntry } from "@/types"

import { MessageDiffView } from "@/components/detail/diff/MessageDiffView"
import { StagesSegment } from "@/components/detail/segments/StagesSegment"

const msg = (role: string, content: string): MessageContent => ({ role, content }) as MessageContent

describe("MessageDiffView", () => {
  it("renders modified / removed / added rows + summary badge", () => {
    const left = [
      //
      msg("user", "hello"),
      msg("assistant", "world"),
      msg("system", "drop me"),
    ]
    const right = [
      //
      msg("user", "hello"),
      msg("assistant", "world CHANGED"),
      msg("extra", "added me"),
    ]
    render(
      <MessageDiffView
        left={left}
        right={right}
      />,
    )
    // modified row → inline word diff exposes the changed word
    expect(screen.getByText("CHANGED")).toBeDefined()
    // added (right-only) message preview renders
    expect(screen.getByText(/added me/)).toBeDefined()
    // removed (left-only) message preview renders
    expect(screen.getByText(/drop me/)).toBeDefined()
    // summary badge: 1 modified ~, 1 removed −, 1 added +, 1 same unchanged
    expect(screen.getByText(/1~ 1− 1\+ · 1 unchanged/)).toBeDefined()
  })

  it("caps at MAX_ROWS and shows a +K more notice", () => {
    const left = Array.from({ length: 405 }, (_, i) => msg("user", `m${i}`))
    const right = Array.from({ length: 405 }, (_, i) => msg("user", `m${i}`))
    render(
      <MessageDiffView
        left={left}
        right={right}
      />,
    )
    expect(screen.getByText(/\+5 more messages\./)).toBeDefined()
  })
})

const baseEntry = (effectiveMessages?: Array<MessageContent>): HistoryEntry =>
  ({
    id: "r1",
    startedAt: 0,
    endpoint: "anthropic-messages",
    clientRequest: { messages: [msg("user", "hello")] },
    ...(effectiveMessages ? { attempts: [{ index: 0, durationMs: 0, effectiveSource: { messages: effectiveMessages } }] } : {}),
  }) as unknown as HistoryEntry

describe("StagesSegment inbound↔effective toggle", () => {
  it("shows the diff toggle button when both message sets exist", () => {
    render(<StagesSegment entry={baseEntry([msg("user", "hello rewritten")])} />)
    expect(screen.getByText(/show full diff/)).toBeDefined()
  })

  it("hides the diff toggle when there is no effective request", () => {
    render(<StagesSegment entry={baseEntry()} />)
    expect(screen.queryByText(/show full diff/)).toBeNull()
  })

  it("reveals the MessageDiffView when the toggle is clicked", () => {
    render(<StagesSegment entry={baseEntry([msg("user", "hello rewritten")])} />)
    expect(screen.queryByText(/Inbound ↔ Effective diff/)).toBeNull()
    fireEvent.click(screen.getByText(/show full diff/))
    expect(screen.getByText(/Inbound ↔ Effective diff/)).toBeDefined()
    // the rewritten word surfaces in the inline diff (also appears as a rewrite badge)
    expect(screen.getAllByText("rewritten").length).toBeGreaterThan(0)
  })
})

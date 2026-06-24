import {
  //
  render,
  screen,
} from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

import type { SessionSummary } from "@/types"

import { SessionRow } from "@/components/sessions/SessionRow"

const base = (over: Partial<SessionSummary>): SessionSummary => ({
  sessionId: "a3f1aaaaaaaa9c2",
  requestCount: 34,
  agentCount: 4,
  inputTokens: 1000,
  outputTokens: 500,
  firstStartedAt: 0,
  lastStartedAt: 720_000,
  completed: 34,
  failed: 0,
  models: ["opus"],
  preview: "",
  ...over,
})

function renderRow(s: SessionSummary) {
  return render(
    <MemoryRouter>
      <SessionRow s={s} />
    </MemoryRouter>,
  )
}

describe("SessionRow", () => {
  it("renders a green (ok) status block when there are no failures", () => {
    const { container } = renderRow(base({ failed: 0 }))
    const block = container.querySelector('span[title="all ok"]')
    expect(block).not.toBeNull()
    expect((block as HTMLElement).style.background).toContain("--color-ok")
  })

  it("renders a red (fail) status block when there are failures", () => {
    const { container } = renderRow(base({ failed: 2 }))
    const block = container.querySelector('span[title="2 failed"]')
    expect(block).not.toBeNull()
    expect((block as HTMLElement).style.background).toContain("--color-fail")
  })

  it("renders the last-message preview text in the row", () => {
    renderRow(base({ preview: "[tool_result: call_1]" }))
    expect(screen.getByText("[tool_result: call_1]")).toBeDefined()
  })

  it("renders a dim em-dash placeholder when preview is empty", () => {
    renderRow(base({ preview: "" }))
    expect(screen.getByText("—")).toBeDefined()
  })

  it("renders compacted token counts and the metadata aggregates", () => {
    renderRow(base({ requestCount: 34, agentCount: 4, inputTokens: 1500, outputTokens: 500 }))
    expect(screen.getByText("34 req")).toBeDefined()
    expect(screen.getByText("4 agents")).toBeDefined()
    // formatNumber compacts 1500 → "1.5K", 500 stays "500"
    expect(screen.getByText("↑1.5K ↓500")).toBeDefined()
  })

  it("preview cell carries the full preview text as its hover title", () => {
    const preview = "the full last-message summary that visually ellipsizes in the row"
    renderRow(base({ preview }))
    const cell = screen.getByText(preview)
    expect(cell.getAttribute("title")).toBe(preview)
  })

  it("sessionId cell shows a truncated id but carries the full id as its hover title", () => {
    renderRow(base({ sessionId: "a3f1aaaaaaaa9c2" }))
    const cell = screen.getByText("a3f1aaaaaaaa…")
    expect(cell.getAttribute("title")).toBe("a3f1aaaaaaaa9c2")
  })
})

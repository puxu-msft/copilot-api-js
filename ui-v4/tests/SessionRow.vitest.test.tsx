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
  aborted: 0,
  models: ["opus"],
  firstPreview: "",
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
    const { container } = renderRow(base({ completed: 34, failed: 0 }))
    const block = container.querySelector('span[title="34 ok / 0 fail"]')
    expect(block).not.toBeNull()
    expect((block as HTMLElement).style.background).toContain("--color-ok")
  })

  it("renders a red (fail) status block when there are failures", () => {
    const { container } = renderRow(base({ completed: 32, failed: 2 }))
    const block = container.querySelector('span[title="32 ok / 2 fail"]')
    expect(block).not.toBeNull()
    expect((block as HTMLElement).style.background).toContain("--color-fail")
  })

  it("shows main+N when subagents participated", () => {
    renderRow(base({ agentCount: 4 }))
    expect(screen.getByText("main+4")).toBeDefined()
  })

  it("shows bare main for a main-agent-only session (agentCount 0)", () => {
    renderRow(base({ agentCount: 0 }))
    expect(screen.getByText("main")).toBeDefined()
  })

  it("renders completed/failed counts separately", () => {
    renderRow(base({ completed: 34, failed: 1 }))
    expect(screen.getByText("✓34")).toBeDefined()
    expect(screen.getByText("✗1")).toBeDefined()
  })

  it("shows aborted count when present, hides it at zero", () => {
    renderRow(base({ completed: 12, failed: 2, aborted: 11 }))
    expect(screen.getByText("⊘11")).toBeDefined()
  })

  it("renders both first and last user previews", () => {
    renderRow(base({ firstPreview: "分析 sessions 聚合", preview: "你从哪发现的" }))
    expect(screen.getByText(/分析 sessions 聚合/)).toBeDefined()
    expect(screen.getByText(/你从哪发现的/)).toBeDefined()
  })

  it("renders compacted token counts and the metadata aggregates", () => {
    renderRow(base({ requestCount: 34, inputTokens: 1500, outputTokens: 500 }))
    expect(screen.getByText("34 req")).toBeDefined()
    expect(screen.getByText("↑1.5K ↓500")).toBeDefined()
  })

  it("sessionId cell shows a truncated id but carries the full id as its hover title", () => {
    renderRow(base({ sessionId: "a3f1aaaaaaaa9c2" }))
    const cell = screen.getByText("a3f1aaaaaaaa…")
    expect(cell.getAttribute("title")).toBe("a3f1aaaaaaaa9c2")
  })
})

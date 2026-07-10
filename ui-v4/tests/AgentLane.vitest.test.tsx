import {
  //
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import {
  //
  MemoryRouter,
  Route,
  Routes,
} from "react-router-dom"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

import type { EntrySummary } from "@/types"

import { AgentLane } from "@/components/sessions/AgentLane"

const base = (over: Partial<EntrySummary>): EntrySummary => ({
  id: "x",
  startedAt: new Date(2026, 0, 1, 9, 5, 3).getTime(),
  endpoint: "anthropic-messages",
  messageCount: 0,
  previewText: "",
  responsePreviewText: "",
  ...over,
})

function renderLane(name: string, entries: Array<EntrySummary>) {
  return render(
    <MemoryRouter initialEntries={["/sessions/s1"]}>
      <Routes>
        <Route
          path="/sessions/:id"
          element={
            <AgentLane
              name={name}
              entries={entries}
            />
          }
        />
        <Route
          path="/requests/:id"
          element={<div>request-detail</div>}
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe("AgentLane", () => {
  it("renders a header (name + req count) and the entries as RequestRow rows, not colored blocks", () => {
    const { container } = renderLane("main agent", [
      base({
        id: "r1",
        state: "completed",
        startedAt: new Date(2026, 0, 1, 9, 5, 3).getTime(),
        responseModel: "claude-opus-4.8",
        usage: { input_tokens: 1500, output_tokens: 250 },
      }),
      base({
        id: "r2",
        state: "completed",
        startedAt: new Date(2026, 0, 1, 10, 6, 7).getTime(),
        responseModel: "claude-sonnet-4.5",
        usage: { input_tokens: 200, output_tokens: 80 },
      }),
    ])
    // header: agent name + request count + token summary
    expect(screen.getByText("main agent")).toBeDefined()
    expect(screen.getByText(/2 req · ↑1\.7K ↓330/)).toBeDefined()
    // entries render as dense RequestRow rows (model + time text of each), not blocks
    expect(screen.getByText("claude-opus-4.8")).toBeDefined()
    expect(screen.getByText("claude-sonnet-4.5")).toBeDefined()
    expect(screen.getByText("09:05:03")).toBeDefined()
    expect(screen.getByText("10:06:07")).toBeDefined()
    // no colored block buttons remain (old h-3.5 w-6 squares)
    expect(container.querySelector(String.raw`.h-3\.5.w-6`)).toBeNull()
  })

  it("surfaces the summed cache tokens in the header (disjoint from net input)", () => {
    renderLane("cached agent", [
      base({ id: "c1", state: "completed", usage: { input_tokens: 600, output_tokens: 250, cache_read_input_tokens: 400 } }),
      base({ id: "c2", state: "completed", usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200 } }),
    ])
    // net input 600+100=700; cache 400+200=600 (shown separately, not folded into ↑).
    expect(screen.getByText(/2 req · ↑700 ↓300 · cache 600/)).toBeDefined()
  })

  it("shows a red failed count in the header when entries failed, and rows deep-link to /requests/:id", () => {
    renderLane("subagent agent-expl", [
      base({ id: "r1", state: "completed", responseModel: "claude-opus-4.8" }),
      base({ id: "r2", state: "failed", responseModel: "claude-opus-4.8", responseError: "boom" }),
    ])
    expect(screen.getByText("1 failed")).toBeDefined()
    // each row is a button; clicking the first navigates to the request detail
    const rows = screen.getAllByRole("button")
    fireEvent.click(rows[0])
    expect(screen.getByText("request-detail")).toBeDefined()
  })
})

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
  vi,
} from "vitest"

vi.mock("@/hooks/useSessionEntries", () => ({
  useSessionEntries: () => ({
    data: {
      entries: [
        { id: "r1", startedAt: 1, state: "completed", endpoint: "anthropic-messages", messageCount: 0, previewText: "" },
        {
          id: "r2",
          agentId: "agent-explore-xyz",
          startedAt: 2,
          state: "completed",
          endpoint: "anthropic-messages",
          messageCount: 0,
          previewText: "",
        },
        {
          id: "r3",
          agentId: "agent-explore-xyz",
          startedAt: 3,
          state: "failed",
          endpoint: "anthropic-messages",
          messageCount: 0,
          previewText: "",
        },
      ],
      total: 3,
    },
    isLoading: false,
  }),
}))

const { SessionDetailPage } = await import("@/components/sessions/SessionDetailPage")

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/sessions/:id"
          element={<SessionDetailPage />}
        />
        <Route
          path="/requests/:id"
          element={<div>request-detail</div>}
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe("SessionDetailPage", () => {
  it("renders main + subagent lanes; blocks deep-link to /requests/:id", () => {
    renderAt("/sessions/sess-1")
    expect(screen.getByText(/main agent/)).toBeDefined()
    expect(screen.getByText(/subagent agent-expl/)).toBeDefined()
    expect(screen.getByText(/3 req · 2 lanes/)).toBeDefined()
    // a request block (button) navigates
    const blocks = screen.getAllByRole("button")
    fireEvent.click(blocks[0])
    expect(screen.getByText("request-detail")).toBeDefined()
  })
})

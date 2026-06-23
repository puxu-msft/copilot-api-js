import {
  //
  render,
  screen,
  fireEvent,
} from "@testing-library/react"
import {
  //
  MemoryRouter,
  Routes,
  Route,
} from "react-router-dom"
import {
  //
  describe,
  expect,
  it,
  vi,
} from "vitest"

vi.mock("@/hooks/useSessions", () => ({
  useSessions: () => ({
    data: {
      sessions: [
        {
          sessionId: "a3f1aaaaaaaa9c2",
          requestCount: 34,
          agentCount: 4,
          inputTokens: 1000,
          outputTokens: 500,
          firstStartedAt: 0,
          lastStartedAt: 720000,
          completed: 33,
          failed: 1,
          models: ["opus"],
        },
      ],
    },
    isLoading: false,
  }),
}))

const { SessionsPage } = await import("@/components/sessions/SessionsPage")

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <Routes>
        <Route
          path="/sessions"
          element={<SessionsPage />}
        />
        <Route
          path="/sessions/:id"
          element={<div>detail-page</div>}
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe("SessionsPage", () => {
  it("renders session rows with aggregates + navigates on click", () => {
    renderPage()
    expect(screen.getByText(/34 req/)).toBeDefined()
    expect(screen.getByText(/4 agents/)).toBeDefined()
    expect(screen.getByText(/1 fail/)).toBeDefined()
    expect(screen.getByText(/Sessions · 1/)).toBeDefined()
    fireEvent.click(screen.getByText(/34 req/))
    expect(screen.getByText("detail-page")).toBeDefined() // navigated
  })
})

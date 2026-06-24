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

vi.mock("@/hooks/useEntry", () => ({
  useEntry: () => ({
    data: {
      id: "r1",
      startedAt: 0,
      endpoint: "anthropic-messages",
      state: "completed",
      inboundRequest: { messages: [{ role: "user", content: "convo body text" }] },
    },
    isLoading: false,
    isError: false,
    error: null,
  }),
}))

const { DetailPanel } = await import("@/components/detail/DetailPanel")

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/requests/:id"
          element={<DetailPanel />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe("DetailPanel", () => {
  it("renders diagnostic bar + default Convo segment", () => {
    renderAt("/requests/r1")
    expect(screen.getByText(/anthropic-messages/)).toBeDefined()
    // "convo body text" appears in both the TOC label and the content body.
    expect(screen.getAllByText(/convo body text/).length).toBeGreaterThan(0)
  })
  it("switches segment via sub-rail", () => {
    renderAt("/requests/r1")
    fireEvent.click(screen.getByText("Stages"))
    expect(screen.getByText(/Inbound \(client → proxy\)/)).toBeDefined()
  })
})

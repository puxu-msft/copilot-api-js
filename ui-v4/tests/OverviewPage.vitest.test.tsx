import {
  //
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

vi.mock("@/hooks/useStatus", () => ({
  useStatus: () => ({
    data: {
      activeRequests: { count: 2 },
      rateLimiter: { enabled: true, mode: "normal" },
      quota: { status: "ok" },
      memory: { historyEntryCount: 42 },
      upstream_ws: { enabled: false },
    },
    isLoading: false,
  }),
}))

const { OverviewPage } = await import("@/components/overview/OverviewPage")
const { useLiveStore } = await import("@/stores/live-store")

describe("OverviewPage", () => {
  beforeEach(() => {
    useLiveStore.setState({ byId: {} })
  })

  it("renders health stat cards + Grafana block", () => {
    render(<OverviewPage />)
    expect(screen.getByText("In-flight")).toBeDefined()
    expect(screen.getByText("normal")).toBeDefined()
    expect(screen.getByText("ok")).toBeDefined()
    expect(screen.getByText("42")).toBeDefined()
    expect(screen.getByText(/Grafana/)).toBeDefined()
  })
})

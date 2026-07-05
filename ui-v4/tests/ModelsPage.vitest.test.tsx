import {
  //
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import {
  //
  describe,
  expect,
  it,
  vi,
} from "vitest"

vi.mock("@/hooks/useModels", () => ({
  useModels: () => ({
    data: {
      data: [
        {
          id: "claude-opus-4.8",
          name: "Opus",
          vendor: "Anthropic",
          version: "4.8",
          capabilities: { type: "chat", supports: { vision: true }, limits: { max_context_window_tokens: 1_000_000 } },
          billing: { multiplier: 3 },
        },
        { id: "gpt-5.5", name: "GPT", vendor: "OpenAI", version: "5.5", capabilities: { type: "chat", supports: {}, limits: {} }, billing: { multiplier: 1 } },
      ],
    },
    isLoading: false,
  }),
}))

vi.mock("@/hooks/useModelTelemetry", () => ({
  useModelTelemetry: () => ({
    data: {
      modelsSinceStart: [],
      modelsLast7d: [
        {
          model: "claude-opus-4.8",
          requestCount: 12,
          successCount: 12,
          failureCount: 0,
          totalDurationMs: 0,
          averageDurationMs: 0,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 },
        },
      ],
    },
  }),
}))

const { ModelsPage } = await import("@/components/models/ModelsPage")

/** ModelsPage now reads selection from the URL (`?model=`), so it needs a router. */
function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/models"]}>
      <ModelsPage />
    </MemoryRouter>,
  )
}

describe("ModelsPage", () => {
  it("renders rows, count, and raw toggle", () => {
    renderPage()
    expect(screen.getByText("claude-opus-4.8")).toBeDefined()
    expect(screen.getByText("gpt-5.5")).toBeDefined()
    expect(screen.getByText(/Models · 2\/2/)).toBeDefined()
    expect(screen.getByRole("columnheader", { name: /Vendor/i })).toBeDefined()
    fireEvent.click(screen.getByText("raw JSON"))
    expect(screen.getByText("table")).toBeDefined()
  })

  it("filters by search (id/name)", () => {
    renderPage()
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "gpt" } })
    expect(screen.getByText("gpt-5.5")).toBeDefined()
    expect(screen.queryByText("claude-opus-4.8")).toBeNull()
    expect(screen.getByText(/Models · 1\/2/)).toBeDefined()
  })

  it("hides a column via the column menu", () => {
    renderPage()
    expect(screen.getByRole("columnheader", { name: /Vendor/i })).toBeDefined()
    fireEvent.click(screen.getByRole("checkbox", { name: /Vendor/i }))
    expect(screen.queryByRole("columnheader", { name: /Vendor/i })).toBeNull()
  })

  it("shows the requests(7d) column when enabled and renders the joined count", () => {
    renderPage()
    // requests7d is hidden by default; enable it
    fireEvent.click(screen.getByRole("checkbox", { name: /Req 7d/i }))
    expect(screen.getByText("12")).toBeDefined()
  })

  it("opens the detail panel on row click and closes it via the × button", () => {
    renderPage()
    expect(screen.queryByRole("region", { name: /Model detail/i })).toBeNull()
    fireEvent.click(screen.getByText("claude-opus-4.8"))
    const panel = screen.getByRole("region", { name: /Model detail: claude-opus-4\.8/i })
    expect(panel).toBeDefined()
    // Overview tab is active by default — the vertical tab rail is present.
    expect(screen.getByRole("tab", { name: "Capabilities" })).toBeDefined()
    expect(screen.getByRole("tab", { name: "Raw JSON" })).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: /Close model detail/i }))
    expect(screen.queryByRole("region", { name: /Model detail/i })).toBeNull()
  })
})

import {
  //
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import {
  //
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

// `useModels` is a drivable mock (vi.hoisted so the fn exists before the hoisted
// vi.mock factory runs) — most tests use the default two-model catalog set in
// beforeEach, while the error-state test overrides it with an isError result.
const { mockUseModels } = vi.hoisted(() => ({ mockUseModels: vi.fn() }))

vi.mock("@/hooks/useModels", () => ({
  useModels: () => mockUseModels(),
}))

const DEFAULT_MODELS_RESULT = {
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
  isError: false,
  error: null,
}

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
        {
          // A pure-alias failing request with no catalog match → surfaces in "Unmatched telemetry".
          model: "ghost-alias",
          requestCount: 3,
          successCount: 0,
          failureCount: 3,
          totalDurationMs: 0,
          averageDurationMs: 0,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 },
        },
      ],
    },
  }),
}))

vi.mock("@/lib/export-entry", () => ({ triggerDownload: vi.fn() }))

const { triggerDownload } = await import("@/lib/export-entry")

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
  // Column visibility persists to localStorage; clear it so one test's toggles
  // don't leak into the next (jsdom localStorage is shared across a file's tests).
  beforeEach(() => {
    localStorage.clear()
    mockUseModels.mockReturnValue(DEFAULT_MODELS_RESULT)
  })

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

  it("hides a column via the column menu", async () => {
    const user = userEvent.setup()
    renderPage()
    expect(screen.getByRole("columnheader", { name: /Vendor/i })).toBeDefined()
    await user.click(screen.getByRole("button", { name: "Columns" }))
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Vendor/i }))
    expect(screen.queryByRole("columnheader", { name: /Vendor/i })).toBeNull()
  })

  it("shows the requests(7d) column when enabled and renders the joined count", async () => {
    const user = userEvent.setup()
    renderPage()
    // requests7d is hidden by default; enable it via the column menu
    await user.click(screen.getByRole("button", { name: "Columns" }))
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Req 7d/i }))
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

  it("makes each row's id a keyboard-reachable button that opens the panel", () => {
    renderPage()
    // The id is a real <button> (native keyboard operability), not a bare cell.
    const trigger = screen.getByRole("button", { name: /Open details for claude-opus-4\.8/i })
    expect(trigger).toBeDefined()
    fireEvent.click(trigger)
    expect(screen.getByRole("region", { name: /Model detail: claude-opus-4\.8/i })).toBeDefined()
  })

  it("sortable headers are keyboard-operable and expose aria-sort", async () => {
    const user = userEvent.setup()
    renderPage()
    const vendorHeader = screen.getByRole("columnheader", { name: /Vendor/i })
    expect(vendorHeader.getAttribute("aria-sort")).toBe("none")
    // The header's control is a real button (WCAG 2.1.1); clicking it drives
    // TanStack's controlled sort (Vendor is a string column → ascending first).
    await user.click(screen.getByRole("button", { name: /Vendor/i }))
    expect(vendorHeader.getAttribute("aria-sort")).toBe("ascending")
  })

  it("exports the current view as a text/csv download", () => {
    vi.mocked(triggerDownload).mockClear()
    renderPage()
    fireEvent.click(screen.getByText("Export CSV"))
    expect(triggerDownload).toHaveBeenCalledTimes(1)
    const [blob, filename] = vi.mocked(triggerDownload).mock.calls[0]
    expect(filename).toBe("models.csv")
    expect(blob.type).toContain("text/csv")
  })

  it("CSV export reflects the active sort order (spec §7: sorted view)", async () => {
    const user = userEvent.setup()
    vi.mocked(triggerDownload).mockClear()
    renderPage()
    // Default is id-asc (claude before gpt). Click Ctx twice → ascending (gpt=0
    // context before claude=1M) → the CSV row order must flip to match the table.
    await user.click(screen.getByRole("button", { name: /^Ctx/i }))
    await user.click(screen.getByRole("button", { name: /^Ctx/i }))
    fireEvent.click(screen.getByText("Export CSV"))
    const [blob] = vi.mocked(triggerDownload).mock.calls[0]
    const text = await blob.text()
    const dataRows = text.split("\n").slice(1) // drop header
    expect(dataRows[0].startsWith("gpt-5.5")).toBe(true)
    expect(dataRows[1].startsWith("claude-opus-4.8")).toBe(true)
  })

  it("surfaces unmatched telemetry (no catalog model) rather than dropping it", () => {
    renderPage()
    expect(screen.getByText(/Unmatched telemetry/i)).toBeDefined()
    expect(screen.getByText("ghost-alias")).toBeDefined()
  })

  // Positive control for the error test's negative assertion below: an empty catalog
  // renders the "No models match…" empty branch, so its ABSENCE in the error case is
  // a meaningful signal (error ≠ empty). getByText throws when absent; queryByText
  // returns null (project convention — jest-dom matchers are not registered).
  it("renders the empty branch when the catalog resolves to zero models", () => {
    mockUseModels.mockReturnValue({ data: { data: [] }, isLoading: false, isError: false, error: null })
    renderPage()
    expect(screen.getByText(/no models match/i)).toBeDefined()
    expect(screen.queryByText(/failed to load models/i)).toBeNull()
  })

  it("renders error state distinct from empty when query fails", () => {
    mockUseModels.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error("boom") })
    renderPage()
    expect(screen.getByText(/failed to load models/i)).toBeDefined()
    expect(screen.getByText(/boom/)).toBeDefined()
    expect(screen.queryByText(/no models match/i)).toBeNull()
  })
})

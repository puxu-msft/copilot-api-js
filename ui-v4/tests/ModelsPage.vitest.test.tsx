import {
  //
  render,
  screen,
  fireEvent,
} from "@testing-library/react"
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
        { id: "claude-opus-4.8", name: "Opus", vendor: "Anthropic", version: "4.8" },
        { id: "gpt-5.5", name: "GPT", vendor: "OpenAI", version: "5.5" },
      ],
    },
    isLoading: false,
  }),
}))

const { ModelsPage } = await import("@/components/models/ModelsPage")

describe("ModelsPage", () => {
  it("renders model rows + raw toggle", () => {
    render(<ModelsPage />)
    expect(screen.getByText("claude-opus-4.8")).toBeDefined()
    expect(screen.getByText("Anthropic")).toBeDefined()
    expect(screen.getByText(/Models · 2/)).toBeDefined()
    fireEvent.click(screen.getByText("raw JSON"))
    expect(screen.getByText("table")).toBeDefined() // toggle flipped
  })
})

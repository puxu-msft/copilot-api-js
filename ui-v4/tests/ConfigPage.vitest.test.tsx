import {
  //
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import {
  //
  describe,
  expect,
  it,
  vi,
} from "vitest"

const mutate = vi.fn()
vi.mock("@/hooks/useConfigYaml", () => ({
  useConfigYaml: () => ({
    query: { data: { proxy: "http://x", model_refresh_interval: 600 }, isLoading: false },
    save: { mutate, isPending: false, isError: false, isSuccess: false, error: null },
  }),
}))

const { ConfigPage } = await import("@/components/config/ConfigPage")

describe("ConfigPage", () => {
  it("renders config as JSON text and saves parsed object", () => {
    render(<ConfigPage />)
    const ta = screen.getByRole<HTMLTextAreaElement>("textbox")
    expect(ta.value).toContain("model_refresh_interval")
    fireEvent.click(screen.getByText("save"))
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ proxy: "http://x" }))
  })
})

import {
  //
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  //
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { RequestsFilterBar } from "@/components/requests/RequestsFilterBar"
import { EMPTY_FILTERS } from "@/lib/request-filters"

afterEach(() => vi.useRealTimers())

describe("RequestsFilterBar", () => {
  it("debounces model input → setFilter('model', value) after 300ms", () => {
    vi.useFakeTimers()
    const setFilter = vi.fn()
    render(
      <RequestsFilterBar
        filters={EMPTY_FILTERS}
        setFilter={setFilter}
        columnMenuSlot={null}
      />,
    )
    fireEvent.change(screen.getByLabelText("Filter by model"), { target: { value: "opus" } })
    // 防抖未到点:尚未提交给 setFilter。
    expect(setFilter).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(setFilter).toHaveBeenCalledWith("model", "opus")
  })

  it("emits setFilter('endpoint', ...) on endpoint select", async () => {
    const user = userEvent.setup()
    const setFilter = vi.fn()
    render(
      <RequestsFilterBar
        filters={EMPTY_FILTERS}
        setFilter={setFilter}
        columnMenuSlot={null}
      />,
    )
    await user.click(screen.getByRole("combobox", { name: "Endpoint" }))
    await user.click(screen.getByRole("option", { name: "anthropic-messages" }))
    expect(setFilter).toHaveBeenCalledWith("endpoint", "anthropic-messages")
  })

  it("state select lists only terminal states (no streaming/pending/executing)", async () => {
    const user = userEvent.setup()
    render(
      <RequestsFilterBar
        filters={EMPTY_FILTERS}
        setFilter={vi.fn()}
        columnMenuSlot={null}
      />,
    )
    await user.click(screen.getByRole("combobox", { name: "State" }))
    const optionNames = screen.getAllByRole("option").map((o) => o.textContent)
    // 红线:只列终态。
    expect(optionNames).toContain("completed")
    expect(optionNames).toContain("failed")
    expect(optionNames).toContain("aborted")
    expect(optionNames).toContain("interrupted")
    expect(optionNames).not.toContain("streaming")
    expect(optionNames).not.toContain("pending")
    expect(optionNames).not.toContain("executing")
  })

  it("backfills local model input when filters.model is externally cleared", () => {
    const setFilter = vi.fn()
    const { rerender } = render(
      <RequestsFilterBar
        filters={{ ...EMPTY_FILTERS, model: "opus" }}
        setFilter={setFilter}
        columnMenuSlot={null}
      />,
    )
    const input = screen.getByLabelText<HTMLInputElement>("Filter by model")
    expect(input.value).toBe("opus")
    rerender(
      <RequestsFilterBar
        filters={EMPTY_FILTERS}
        setFilter={setFilter}
        columnMenuSlot={null}
      />,
    )
    expect(input.value).toBe("")
  })
})

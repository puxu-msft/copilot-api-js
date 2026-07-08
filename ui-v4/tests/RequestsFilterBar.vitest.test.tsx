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
        setFilters={vi.fn()}
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
        setFilters={vi.fn()}
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
        setFilters={vi.fn()}
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
        setFilters={vi.fn()}
        columnMenuSlot={null}
      />,
    )
    const input = screen.getByLabelText<HTMLInputElement>("Filter by model")
    expect(input.value).toBe("opus")
    rerender(
      <RequestsFilterBar
        filters={EMPTY_FILTERS}
        setFilter={setFilter}
        setFilters={vi.fn()}
        columnMenuSlot={null}
      />,
    )
    expect(input.value).toBe("")
  })

  it("date-range onChange batches from+to via setFilters in one call (never drops 'from')", async () => {
    const user = userEvent.setup()
    const setFilters = vi.fn()
    render(
      <RequestsFilterBar
        filters={EMPTY_FILTERS}
        setFilter={vi.fn()}
        setFilters={setFilters}
        columnMenuSlot={null}
      />,
    )
    // 打开时间范围 popover(Radix Trigger 需真实 pointer+focus 序列 → userEvent),选当前月 15 号。
    await user.click(screen.getByRole("button", { name: /time range/i }))
    await user.click(screen.getByText("15"))
    // 关键回归:一次 setFilters 落两维,from 与 to 同时传入(不因全量重写丢下界)。
    expect(setFilters).toHaveBeenCalledTimes(1)
    const patch = setFilters.mock.calls[0][0] as { from: number | null; to: number | null }
    expect(patch.from).not.toBeNull()
    expect(patch.to).not.toBeNull()
    expect((patch.to as number) - (patch.from as number)).toBe(86_399_999)
  })
})

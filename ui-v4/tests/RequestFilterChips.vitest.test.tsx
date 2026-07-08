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

import { RequestFilterChips } from "@/components/requests/RequestFilterChips"
import { EMPTY_FILTERS } from "@/lib/request-filters"

describe("RequestFilterChips", () => {
  it("renders one closable chip per active dimension + a Clear all button", () => {
    render(
      <RequestFilterChips
        filters={{ ...EMPTY_FILTERS, model: "opus", pid: 7 }}
        clearFilter={vi.fn()}
        clearAll={vi.fn()}
        setFilters={vi.fn()}
      />,
    )
    // getByText/getByRole 未命中即抛,存在即断言通过(本项目未装 jest-dom matchers)。
    expect(screen.getByText("model: opus")).toBeTruthy()
    expect(screen.getByText("pid: 7")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy()
  })

  it("clears a single dimension via clearFilter(key)", () => {
    const clearFilter = vi.fn()
    render(
      <RequestFilterChips
        filters={{ ...EMPTY_FILTERS, model: "opus", pid: 7 }}
        clearFilter={clearFilter}
        clearAll={vi.fn()}
        setFilters={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Remove filter model: opus" }))
    expect(clearFilter).toHaveBeenCalledWith("model")
  })

  it("Clear all button invokes clearAll", () => {
    const clearAll = vi.fn()
    render(
      <RequestFilterChips
        filters={{ ...EMPTY_FILTERS, model: "opus", pid: 7 }}
        clearFilter={vi.fn()}
        clearAll={clearAll}
        setFilters={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }))
    expect(clearAll).toHaveBeenCalledTimes(1)
  })

  it("clears the time chip via batched setFilters({ from: null, to: null }) — never clearFilter", () => {
    const clearFilter = vi.fn()
    const setFilters = vi.fn()
    render(
      <RequestFilterChips
        filters={{ ...EMPTY_FILTERS, from: 1_700_000_000_000, to: 1_700_086_399_999 }}
        clearFilter={clearFilter}
        clearAll={vi.fn()}
        setFilters={setFilters}
      />,
    )
    // time chip 的 key 是 "from" 或 "to";× 必须一次批量清两维,绝不连调 clearFilter(否则全量重写只清一个)。
    fireEvent.click(screen.getByRole("button", { name: /^Remove filter time:/ }))
    expect(setFilters).toHaveBeenCalledTimes(1)
    expect(setFilters).toHaveBeenCalledWith({ from: null, to: null })
    expect(clearFilter).not.toHaveBeenCalled()
  })

  it("renders nothing when no dimension is active", () => {
    const { container } = render(
      <RequestFilterChips
        filters={EMPTY_FILTERS}
        clearFilter={vi.fn()}
        clearAll={vi.fn()}
        setFilters={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})

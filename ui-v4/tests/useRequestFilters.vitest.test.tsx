import {
  //
  render,
  screen,
  fireEvent,
} from "@testing-library/react"
import {
  //
  MemoryRouter,
  useSearchParams,
} from "react-router-dom"
import {
  //
  describe,
  expect,
  test,
} from "vitest"

import { useRequestFilters } from "@/hooks/useRequestFilters"

function Probe() {
  const { filters, setFilter, setFilters, clearFilter, clearAll } = useRequestFilters()
  const [sp] = useSearchParams()
  return (
    <div>
      <span data-testid="model">{filters.model}</span>
      <span data-testid="from">{filters.from ?? ""}</span>
      <span data-testid="to">{filters.to ?? ""}</span>
      <span data-testid="at">{sp.get("at") ?? ""}</span>
      <button onClick={() => setFilter("model", "opus")}>set</button>
      <button onClick={() => setFilters({ from: 1000, to: 2000 })}>setRange</button>
      <button onClick={() => clearFilter("model")}>clear</button>
      <button onClick={() => clearAll()}>clearAll</button>
    </div>
  )
}

describe("useRequestFilters", () => {
  test("setFilter reflects into URL and preserves ?at=", () => {
    render(
      <MemoryRouter initialEntries={["/requests?at=abc"]}>
        <Probe />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByText("set"))
    expect(screen.getByTestId("model").textContent).toBe("opus")
    expect(screen.getByTestId("at").textContent).toBe("abc") // at preserved
    fireEvent.click(screen.getByText("clear"))
    expect(screen.getByTestId("model").textContent).toBe("")
    expect(screen.getByTestId("at").textContent).toBe("abc")
  })

  test("setFilters writes multiple dims in one write (from+to) and preserves ?at=", () => {
    render(
      <MemoryRouter initialEntries={["/requests?at=abc"]}>
        <Probe />
      </MemoryRouter>,
    )
    // 单个事件里一次落两维:from 不被后写的 to 覆盖丢弃(全量重写 bug 的回归防线)。
    fireEvent.click(screen.getByText("setRange"))
    expect(screen.getByTestId("from").textContent).toBe("1000")
    expect(screen.getByTestId("to").textContent).toBe("2000")
    expect(screen.getByTestId("at").textContent).toBe("abc") // at preserved
  })
})

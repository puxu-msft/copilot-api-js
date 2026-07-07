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
  const { filters, setFilter, clearFilter, clearAll } = useRequestFilters()
  const [sp] = useSearchParams()
  return (
    <div>
      <span data-testid="model">{filters.model}</span>
      <span data-testid="at">{sp.get("at") ?? ""}</span>
      <button onClick={() => setFilter("model", "opus")}>set</button>
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
})

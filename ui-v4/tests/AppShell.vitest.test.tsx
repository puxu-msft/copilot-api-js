import {
  //
  QueryClientProvider,
  QueryClient,
} from "@tanstack/react-query"
import {
  //
  render,
  screen,
} from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

import { NavRail } from "@/components/shell/NavRail"

describe("NavRail", () => {
  it("renders the five nav items", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <NavRail />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.getByText("Requests")).toBeDefined()
    expect(screen.getByText("Sessions")).toBeDefined()
    expect(screen.getByText("Config")).toBeDefined()
  })
})

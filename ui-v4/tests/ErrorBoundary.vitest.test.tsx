import {
  //
  render,
  screen,
} from "@testing-library/react"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

import { ErrorBoundary } from "@/components/detail/ErrorBoundary"

function Boom(): never {
  throw new Error("kaboom")
}

describe("ErrorBoundary", () => {
  it("renders fallback when a child throws", () => {
    render(
      <ErrorBoundary label="block">
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByText(/block/)).toBeDefined()
  })
  it("renders children when no throw", () => {
    render(
      <ErrorBoundary label="block">
        <span>ok</span>
      </ErrorBoundary>,
    )
    expect(screen.getByText("ok")).toBeDefined()
  })
})

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

import {
  //
  DetailSubRail,
  SEGMENTS,
} from "@/components/detail/DetailSubRail"

/**
 * Golden behavior lock for `DetailSubRail` BEFORE the Radix Tabs migration (P1).
 * It is currently plain buttons with NO tab semantics — migrating to Radix Tabs
 * is a behavior UPGRADE, so locking the current click→onSelect contract first is
 * important. See plans/2026-07-05-radix-migration.md §P0.
 */
describe("DetailSubRail (golden, pre-Radix)", () => {
  it("renders every segment", () => {
    render(
      <DetailSubRail
        active="Convo"
        onSelect={() => {}}
      />,
    )
    for (const seg of SEGMENTS) expect(screen.getByText(seg)).toBeDefined()
  })

  it("calls onSelect with the clicked segment", () => {
    const onSelect = vi.fn()
    render(
      <DetailSubRail
        active="Convo"
        onSelect={onSelect}
      />,
    )
    fireEvent.click(screen.getByText("SSE"))
    expect(onSelect).toHaveBeenCalledWith("SSE")
  })
})

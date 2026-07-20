import {
  //
  render,
  screen,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  //
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { ModelsColumnMenu } from "@/components/models/ModelsColumnMenu"
import { DEFAULT_COLUMN_VISIBILITY } from "@/lib/model-columns"

/**
 * `ModelsColumnMenu` migrated to Radix `DropdownMenu` (P2). The menu is closed
 * by default (Portal content not in the DOM), so each test opens it first via
 * userEvent; items are now `menuitemcheckbox`/`menuitem` (not checkbox/button).
 * Verifies the same contract the pre-Radix golden locked: reflect visibility,
 * onToggle(key), onReset.
 */
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Columns" }))
}

describe("ModelsColumnMenu (Radix DropdownMenu)", () => {
  it("renders a menuitemcheckbox per column reflecting visibility", async () => {
    const user = userEvent.setup()
    render(
      <ModelsColumnMenu
        columns={{ ...DEFAULT_COLUMN_VISIBILITY, vendor: false }}
        onToggle={() => {}}
        onReset={() => {}}
      />,
    )
    await openMenu(user)
    expect(screen.getByRole("menuitemcheckbox", { name: /Vendor/i }).getAttribute("aria-checked")).toBe("false")
    expect(screen.getByRole("menuitemcheckbox", { name: /Context/i }).getAttribute("aria-checked")).toBe("true")
  })

  it("calls onToggle with the column key when an item is clicked", async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(
      <ModelsColumnMenu
        columns={DEFAULT_COLUMN_VISIBILITY}
        onToggle={onToggle}
        onReset={() => {}}
      />,
    )
    await openMenu(user)
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Streaming/i }))
    expect(onToggle).toHaveBeenCalledWith("streaming")
  })

  it("keeps the menu open after a toggle (multi-select)", async () => {
    const user = userEvent.setup()
    render(
      <ModelsColumnMenu
        columns={DEFAULT_COLUMN_VISIBILITY}
        onToggle={() => {}}
        onReset={() => {}}
      />,
    )
    await openMenu(user)
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Streaming/i }))
    // Still open → other items remain queryable.
    expect(screen.getByRole("menuitemcheckbox", { name: /Vision/i })).toBeDefined()
  })

  it("calls onReset when Reset is clicked", async () => {
    const user = userEvent.setup()
    const onReset = vi.fn()
    render(
      <ModelsColumnMenu
        columns={DEFAULT_COLUMN_VISIBILITY}
        onToggle={() => {}}
        onReset={onReset}
      />,
    )
    await openMenu(user)
    await user.click(screen.getByRole("menuitem", { name: /Reset/i }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })
})

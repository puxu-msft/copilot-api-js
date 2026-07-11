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

import { RequestsColumnMenu } from "@/components/requests/RequestsColumnMenu"
import {
  //
  DEFAULT_COLUMN_ORDER,
  DEFAULT_COLUMN_VISIBILITY,
} from "@/lib/request-columns"

/**
 * `RequestsColumnMenu` 镜像 `ModelsColumnMenu`(Radix `DropdownMenu`),驱动 TanStack
 * `VisibilityState`(列 id → bool)。菜单默认关闭(Portal content 不在 DOM),故每例先经
 * userEvent 打开;项是 `menuitemcheckbox`/`menuitem`。锁契约:反映可见性、onToggle(id)、onReset。
 */
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Columns" }))
}

describe("RequestsColumnMenu (Radix DropdownMenu)", () => {
  it("renders a menuitemcheckbox per column reflecting visibility", async () => {
    const user = userEvent.setup()
    render(
      <RequestsColumnMenu
        columns={{ ...DEFAULT_COLUMN_VISIBILITY, model: false }}
        order={DEFAULT_COLUMN_ORDER}
        onToggle={() => {}}
        onReset={() => {}}
      />,
    )
    await openMenu(user)
    expect(screen.getByRole("menuitemcheckbox", { name: /Model/i }).getAttribute("aria-checked")).toBe("false")
    expect(screen.getByRole("menuitemcheckbox", { name: /Status/i }).getAttribute("aria-checked")).toBe("true")
  })

  it("calls onToggle with the column id when an item is clicked", async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    render(
      <RequestsColumnMenu
        columns={DEFAULT_COLUMN_VISIBILITY}
        order={DEFAULT_COLUMN_ORDER}
        onToggle={onToggle}
        onReset={() => {}}
      />,
    )
    await openMenu(user)
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Endpoint/i }))
    expect(onToggle).toHaveBeenCalledWith("endpoint")
  })

  it("keeps the menu open after a toggle (multi-select)", async () => {
    const user = userEvent.setup()
    render(
      <RequestsColumnMenu
        columns={DEFAULT_COLUMN_VISIBILITY}
        order={DEFAULT_COLUMN_ORDER}
        onToggle={() => {}}
        onReset={() => {}}
      />,
    )
    await openMenu(user)
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Endpoint/i }))
    // 仍开 → 其它项仍可查询。
    expect(screen.getByRole("menuitemcheckbox", { name: /Tokens/i })).toBeDefined()
  })

  it("calls onReset when Reset is clicked", async () => {
    const user = userEvent.setup()
    const onReset = vi.fn()
    render(
      <RequestsColumnMenu
        columns={DEFAULT_COLUMN_VISIBILITY}
        order={DEFAULT_COLUMN_ORDER}
        onToggle={() => {}}
        onReset={onReset}
      />,
    )
    await openMenu(user)
    await user.click(screen.getByRole("menuitem", { name: /Reset/i }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })
})

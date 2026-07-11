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

import { SessionPaletteSelect } from "@/components/requests/SessionPaletteSelect"
import { SESSION_PALETTES } from "@/lib/session-color"

describe("SessionPaletteSelect", () => {
  it("显示当前色板、切换调 onChange(name)", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <SessionPaletteSelect
        value="terminal-neon"
        onChange={onChange}
      />,
    )
    await user.click(screen.getByRole("combobox"))
    const second = SESSION_PALETTES[1] // oceanic-jewel
    await user.click(screen.getByRole("option", { name: second.label }))
    expect(onChange).toHaveBeenCalledWith(second.name)
  })
})

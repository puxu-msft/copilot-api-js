import {
  //
  render,
  screen,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Tabs } from "radix-ui"
import { useState } from "react"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

import {
  //
  DetailSubRail,
  SEGMENTS,
  type SegmentName,
} from "@/components/detail/DetailSubRail"

/**
 * `DetailSubRail` is now a prop-less Radix `Tabs.List` — its state lives in the
 * enclosing `Tabs.Root` (owned by DetailPanel). Test it in a minimal Tabs harness:
 * every segment renders as a tab, and clicking one switches the active content
 * (Radix roving/keyboard/aria are the library's; DetailPanel covers integration).
 */
function Harness() {
  const [seg, setSeg] = useState<SegmentName>("Convo")
  return (
    <Tabs.Root
      value={seg}
      onValueChange={(v) => setSeg(v as SegmentName)}
      orientation="vertical"
    >
      <DetailSubRail />
      {SEGMENTS.map((s) => (
        <Tabs.Content
          key={s}
          value={s}
        >
          content:{s}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  )
}

describe("DetailSubRail (Radix Tabs.List)", () => {
  it("renders every segment as a tab", () => {
    render(<Harness />)
    for (const seg of SEGMENTS) expect(screen.getByRole("tab", { name: seg })).toBeDefined()
  })

  it("clicking a segment switches the active content", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(screen.getByRole("tabpanel").textContent).toBe("content:Convo")
    await user.click(screen.getByRole("tab", { name: "SSE" }))
    expect(screen.getByRole("tabpanel").textContent).toBe("content:SSE")
  })
})

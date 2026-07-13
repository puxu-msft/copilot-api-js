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

import { DiffRow } from "@/components/detail/diff/DiffRow"
import { InlineParts } from "@/components/detail/diff/InlineParts"

describe("diff primitives", () => {
  it("InlineParts highlights added / removed / plain parts distinctly", () => {
    const { container } = render(<InlineParts parts={[{ value: "kept " }, { value: "newword", added: true }, { value: "oldword", removed: true }]} />)
    // All part text renders.
    expect(screen.getByText(/kept/)).toBeDefined()
    const added = screen.getByText("newword")
    const removed = screen.getByText("oldword")
    const plain = screen.getByText(/kept/)
    // added span carries the ok-tinted background.
    expect(added.className).toMatch(/var\(--content-add\)/)
    expect(added.className).not.toMatch(/line-through/)
    // removed span carries the fail-tinted background + line-through.
    expect(removed.className).toMatch(/var\(--content-del\)/)
    expect(removed.className).toMatch(/line-through/)
    // plain part has no highlight class.
    expect(plain.className).not.toMatch(/var\(--content-add\)/)
    expect(plain.className).not.toMatch(/var\(--content-del\)/)
    expect(plain.className).not.toMatch(/line-through/)
    // Three distinct spans plus the wrapper.
    expect(container.querySelectorAll("span").length).toBeGreaterThanOrEqual(4)
  })

  it("DiffRow renders the correct sign char for each kind", () => {
    const cases: Array<[Parameters<typeof DiffRow>[0]["kind"], string]> = [
      ["same", "="],
      ["added", "+"],
      ["removed", "−"],
      ["modified", "~"],
    ]
    for (const [kind, sign] of cases) {
      const { unmount } = render(
        <DiffRow
          kind={kind}
          label="user"
          bodyText="body text"
        />,
      )
      expect(screen.getByText(sign)).toBeDefined()
      unmount()
    }
  })

  it("DiffRow renders the label and bodyText for a non-modified kind", () => {
    render(
      <DiffRow
        kind="added"
        label="assistant"
        bodyText="hello there"
      />,
    )
    expect(screen.getByText("assistant")).toBeDefined()
    expect(screen.getByText("hello there")).toBeDefined()
  })

  it("DiffRow renders the inline diff (InlineParts path) for modified with inlineParts", () => {
    render(
      <DiffRow
        kind="modified"
        label="user"
        bodyText="ignored fallback"
        inlineParts={[{ value: "before " }, { value: "after", added: true }]}
      />,
    )
    // Inline parts render; the bodyText fallback is NOT used on the modified path.
    expect(screen.getByText(/before/)).toBeDefined()
    const added = screen.getByText("after")
    expect(added.className).toMatch(/var\(--content-add\)/)
    expect(screen.queryByText("ignored fallback")).toBeNull()
  })
})

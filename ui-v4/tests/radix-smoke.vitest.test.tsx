import {
  //
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import { Dialog } from "radix-ui"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

/**
 * P0 地基验证:证明 `radix-ui` 统一包能在 jsdom + vitest 下渲染,且 [setup.ts](./setup.ts)
 * 的 Radix stub(ResizeObserver / pointer-capture)已生效——若 stub 缺失,Radix Dialog
 * 会开箱即 throw。这是 Radix 迁移 P1+(Dialog/Menu/Select/Tabs)测试门禁的前置正样本。
 */
describe("radix-ui jsdom smoke", () => {
  it("renders a Radix Dialog (Portal + focus-scope) under jsdom", () => {
    render(
      <Dialog.Root defaultOpen>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content aria-describedby={undefined}>
            <Dialog.Title>radix smoke</Dialog.Title>
            <Dialog.Close>close</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>,
    )
    // Content is portaled to document.body; role=dialog + title prove it mounted.
    expect(screen.getByRole("dialog")).toBeDefined()
    expect(screen.getByText("radix smoke")).toBeDefined()
    expect(screen.getByText("close")).toBeDefined()
  })

  it("closes on Escape (Radix focus-scope + dismiss wired under jsdom)", () => {
    render(
      <Dialog.Root defaultOpen>
        <Dialog.Portal>
          <Dialog.Content aria-describedby={undefined}>
            <Dialog.Title>esc test</Dialog.Title>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>,
    )
    expect(screen.queryByText("esc test")).not.toBeNull()
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.queryByText("esc test")).toBeNull()
  })
})

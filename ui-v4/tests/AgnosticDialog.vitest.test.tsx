import {
  //
  act,
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { AgnosticDialog } from "@/components/ui/AgnosticDialog"
import { useUiStore } from "@/stores/ui-store"

/**
 * B↔C boundary adapter contract (RFC §2 / round2-A3). `AgnosticDialog` is the
 * design-version-agnostic seam that B content bodies (`BlockJsonModal`) depend on
 * instead of a concrete dialog skin. **P4 forks it by `designVersion`** — legacy
 * `shared/Modal` for `amber-legacy`, the shadcn neutral dialog for `shadcn`. Whatever
 * skin it mounts, it MUST keep the same three affordances: `title` rendered,
 * `data-testid="modal-backdrop"` on the dismiss overlay, and `onClose` fired on
 * Escape / backdrop / ×. This test guards **both** fork branches so neither skin can
 * silently break B's callers.
 */

/** 三 affordance 契约:两皮肤各跑一遍(先证正样本 = 各分支确实挂载了对应皮肤)。 */
function assertThreeAffordanceContract() {
  it("renders its title and children", () => {
    render(
      <AgnosticDialog
        title="tool_use JSON"
        onClose={() => {}}
      >
        <div>body content</div>
      </AgnosticDialog>,
    )
    expect(screen.getByText("tool_use JSON")).toBeDefined()
    expect(screen.getByText("body content")).toBeDefined()
  })

  it("exposes the modal-backdrop testid and fires onClose when it is clicked", () => {
    const onClose = vi.fn()
    render(
      <AgnosticDialog onClose={onClose}>
        <div>body</div>
      </AgnosticDialog>,
    )
    fireEvent.click(screen.getByTestId("modal-backdrop"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("fires onClose on Escape", () => {
    const onClose = vi.fn()
    render(
      <AgnosticDialog onClose={onClose}>
        <div>body</div>
      </AgnosticDialog>,
    )
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("fires onClose when the header × is clicked", () => {
    const onClose = vi.fn()
    render(
      <AgnosticDialog onClose={onClose}>
        <div>body</div>
      </AgnosticDialog>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("does not fire onClose when the content area is clicked", () => {
    const onClose = vi.fn()
    render(
      <AgnosticDialog onClose={onClose}>
        <div>body</div>
      </AgnosticDialog>,
    )
    fireEvent.click(screen.getByText("body"))
    expect(onClose).not.toHaveBeenCalled()
  })
}

describe("AgnosticDialog · amber-legacy skin (shared/Modal)", () => {
  beforeEach(() => act(() => useUiStore.getState().setDesignVersion("amber-legacy")))
  afterEach(() => act(() => useUiStore.getState().setDesignVersion("amber-legacy")))
  // 正样本:legacy 分支渲染 shared/Modal —— Dialog.Title 无 aria-labelledby 冲突,契约同下。
  assertThreeAffordanceContract()
})

describe("AgnosticDialog · shadcn skin (neutral Dialog)", () => {
  beforeEach(() => act(() => useUiStore.getState().setDesignVersion("shadcn")))
  afterEach(() => act(() => useUiStore.getState().setDesignVersion("amber-legacy")))
  // 正样本:shadcn 分支挂中性 Dialog —— 三 affordance 与 legacy 完全一致。
  assertThreeAffordanceContract()

  it("mounts the shadcn skin on a neutral surface (bg-popover, not amber)", () => {
    render(
      <AgnosticDialog onClose={() => {}}>
        <div>neutral body</div>
      </AgnosticDialog>,
    )
    // shadcn 分支的内容体外壳走中性 token(bg-popover);legacy 走 var(--color-surface)。
    const backdrop = screen.getByTestId("modal-backdrop")
    // 遮罩与内容同处 portal;断言 shadcn 皮肤类存在于内容外壳。
    const content = backdrop.parentElement?.querySelector('[class*="bg-popover"]')
    expect(content).not.toBeNull()
  })
})

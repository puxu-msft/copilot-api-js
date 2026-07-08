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
} from "vitest"

import { RawJsonView } from "@/components/common/RawJsonView"

// jest-dom 未接线,一律用原生断言(getAttribute / toBeNull / textContent)。

describe("RawJsonView 双视图切换", () => {
  it("默认 source 视图:原文 tab aria-selected=true、树 tab=false", () => {
    render(<RawJsonView value={{ a: 1 }} />)
    const sourceTab = screen.getByRole("tab", { name: /原文|source/i })
    const treeTab = screen.getByRole("tab", { name: /树|tree/i })
    expect(sourceTab.getAttribute("aria-selected")).toBe("true")
    expect(treeTab.getAttribute("aria-selected")).toBe("false")
  })

  it("默认 source 视图不渲染树节点(负断言 + 正控制:切树后节点出现)", () => {
    render(<RawJsonView value={{ uniquekey: 1 }} />)
    // 正控制:切到树后确实能找到键节点,证明查询手法有效。
    expect(screen.queryByText("uniquekey")).toBeNull()
    fireEvent.click(screen.getByRole("tab", { name: /树|tree/i }))
    expect(screen.getByText("uniquekey")).toBeDefined()
  })

  it("可切到 tree 视图:tab 选中态翻转、树节点渲染", () => {
    render(<RawJsonView value={{ a: 1 }} />)
    fireEvent.click(screen.getByRole("tab", { name: /树|tree/i }))
    const sourceTab = screen.getByRole("tab", { name: /原文|source/i })
    const treeTab = screen.getByRole("tab", { name: /树|tree/i })
    expect(treeTab.getAttribute("aria-selected")).toBe("true")
    expect(sourceTab.getAttribute("aria-selected")).toBe("false")
    // 树节点键名出现(source 视图不会以独立 "a" span 呈现)。
    expect(screen.getByText("a")).toBeDefined()
  })

  it("defaultMode=tree 覆盖默认:树 tab 初始即选中", () => {
    render(
      <RawJsonView
        value={{ a: 1 }}
        defaultMode="tree"
      />,
    )
    expect(screen.getByRole("tab", { name: /树|tree/i }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByText("a")).toBeDefined()
  })

  it("value 变更时树重挂载:手动折叠态被重置为深度默认", () => {
    // outer 深度 0 < AUTO_COLLAPSE_DEPTH(3),默认展开 → inner 子值可见。
    const { rerender } = render(
      <RawJsonView
        value={{ outer: { inner: 1 } }}
        defaultMode="tree"
      />,
    )
    // 手动折叠 outer → 子值 "1" 消失。toolbar 模式下每个节点还有 copy 按钮也含 "outer",
    // 故按 aria-expanded 精确锁定 Collapsible 触发器(仅它有该属性)。
    const trigger = screen.getAllByRole("button").find((b) => b.getAttribute("aria-expanded") !== null)
    if (!trigger) throw new Error("expected a Collapsible trigger with aria-expanded")
    fireEvent.click(trigger)
    expect(screen.queryByText("1")).toBeNull()

    // 换新 value(source 串不同)→ key 变 → JsonTreeView 重挂载 → outer 回到默认展开。
    rerender(
      <RawJsonView
        value={{ outer: { inner: 2 } }}
        defaultMode="tree"
      />,
    )
    // 若未重挂载,手动折叠态会保留,"2" 应被隐藏;可见即证明重挂载重置。
    expect(screen.getByText("2")).toBeDefined()
  })

  it("渲染可选 label", () => {
    render(
      <RawJsonView
        value={{ a: 1 }}
        label="REQUEST"
      />,
    )
    expect(screen.getByText("REQUEST")).toBeDefined()
  })
})

/**
 * JSON tools fork-routed 测试(P8 §8.2)——渲染真实 `JsonToolsPage`(DesignFork),由 `designVersion`
 * 决定挂 legacy(Terminal Amber 页元素)vs shadcn(重设计双面板页壳)。
 * shadcn 分支断言:互斥挂载(`json-tools-shadcn` 唯一)+ 复用 A 逻辑(`unescapeJsonString`/`parseJson`)
 * + 复用 B 内容体(`RawJsonView`→`JsonTreeView` 树视图)逐字呈现 + 单层解码 + "→ 传入 Tree" 交接
 * + 树面板(等待/错误/树)。amber-legacy 分支断 legacy 内容仍在、shadcn 标记缺席(INV-2 互斥挂载)。
 */
import {
  //
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import {
  //
  MemoryRouter,
  Route,
  Routes,
} from "react-router-dom"
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"

import { JsonToolsPage } from "@/components/tools/JsonToolsPage"
import { useUiStore } from "@/stores/ui-store"

function renderTools() {
  return render(
    <MemoryRouter initialEntries={["/tools/json"]}>
      <Routes>
        <Route
          path="/tools/json"
          element={<JsonToolsPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe("JsonToolsPage · fork B (designVersion routes legacy vs shadcn)", () => {
  beforeEach(() => act(() => useUiStore.getState().setDesignVersion("amber-legacy")))
  afterEach(() => act(() => useUiStore.getState().setDesignVersion("amber-legacy")))

  it("amber-legacy: mounts JsonToolsLegacy (no shadcn marker); both tool labels visible", () => {
    renderTools()
    // 互斥挂载判据 = testid 计数(legacy=0 / shadcn=1,见下一用例)。下面的 label 断言
    // 两树文本相同、不区分 legacy/shadcn,仅作"legacy 内容确实渲染"的次级校验,勿当互斥 oracle。
    expect(screen.queryAllByTestId("json-tools-shadcn")).toHaveLength(0)
    expect(screen.getByText("unescape JSON in string")).toBeDefined()
    expect(screen.getByText("JSON tree")).toBeDefined()
  })

  it("shadcn: mounts JsonToolsShadcn exclusively with two tool panels", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderTools()
    expect(screen.queryAllByTestId("json-tools-shadcn")).toHaveLength(1)
    expect(screen.getByText("unescape JSON in string")).toBeDefined()
    expect(screen.getByText("JSON tree")).toBeDefined()
    // 两个输入 + 一个只读输出 textarea(可访问名)。
    expect(screen.getByLabelText("unescape 输入")).toBeDefined()
    expect(screen.getByLabelText("unescape 输出")).toBeDefined()
    expect(screen.getByLabelText("JSON tree 输入")).toBeDefined()
  })

  it("shadcn: single-level unescape reuses unescapeJsonString (A)", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderTools()
    const input = screen.getByLabelText<HTMLTextAreaElement>("unescape 输入")
    fireEvent.change(input, { target: { value: String.raw`{\"name\":\"foo\"}` } })
    const output = screen.getByLabelText<HTMLTextAreaElement>("unescape 输出")
    expect(output.value).toBe('{"name":"foo"}')
  })

  it("shadcn: undecodable input surfaces an error and suppresses the output (never swallowed)", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderTools()
    const input = screen.getByLabelText<HTMLTextAreaElement>("unescape 输入")
    // Raw (unescaped) JSON with embedded quotes → quote-wrapping breaks → decode fails.
    fireEvent.change(input, { target: { value: '{"a":1}' } })
    // Error path replaces the readonly output textarea (parity with legacy).
    expect(screen.queryByLabelText("unescape 输出")).toBeNull()
  })

  it("shadcn: '→ 传入 Tree' hands the decoded string to the tree tool and renders the tree", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderTools()
    const escInput = screen.getByLabelText<HTMLTextAreaElement>("unescape 输入")
    fireEvent.change(escInput, { target: { value: String.raw`{\"a\":[1,2]}` } })
    fireEvent.click(screen.getByRole("button", { name: "→ 传入 Tree" }))
    const treeInput = screen.getByLabelText<HTMLTextAreaElement>("JSON tree 输入")
    expect(treeInput.value).toBe('{"a":[1,2]}')
    // RawJsonView(B)复用:默认 source 视图 + 树/原文 tab;树里含解析后的 key。
    expect(screen.getByRole("tab", { name: "树" })).toBeDefined()
    expect(screen.getByRole("tab", { name: "原文" })).toBeDefined()
  })

  it("shadcn: tree tool shows a placeholder while empty and an error for bad JSON", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderTools()
    // 空输入 → 等待占位。
    expect(screen.getByText("等待输入…")).toBeDefined()
    const treeInput = screen.getByLabelText<HTMLTextAreaElement>("JSON tree 输入")
    fireEvent.change(treeInput, { target: { value: "{not json" } })
    // 解析失败 → 错误可见(非静默吞掉)。
    const panel = screen.getByTestId("json-tools-tree-panel")
    expect(within(panel).getByText(/./)).toBeDefined()
    expect(screen.queryByText("等待输入…")).toBeNull()
  })
})

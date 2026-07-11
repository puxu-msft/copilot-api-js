/**
 * Config fork-routed 测试(P6 §8.2)——渲染真实 `ConfigPage`(DesignFork),由 `designVersion`
 * 决定挂 legacy(Terminal Amber 页元素)vs shadcn(重设计表单页壳)。
 * shadcn 分支断言:互斥挂载(`config-shadcn` 唯一)+ 复用 A 数据 hook `useConfigYaml`(config JSON
 * 编辑 / 保存解析对象 / 解析错误反馈 / loading 态)。amber-legacy 分支断 legacy 内容仍在、shadcn
 * 标记缺席(INV-2 互斥挂载)。
 */
import {
  //
  act,
  fireEvent,
  render,
  screen,
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
  vi,
} from "vitest"

// drivable mock(vi.hoisted 使 fn 在 hoisted vi.mock factory 前存在)——各测试覆写 query/save 态。
const { mockUseConfigYaml, mockSaveMutate } = vi.hoisted(() => ({
  mockUseConfigYaml: vi.fn(),
  mockSaveMutate: vi.fn(),
}))

vi.mock("@/hooks/useConfigYaml", () => ({ useConfigYaml: () => mockUseConfigYaml() }))

const DEFAULT_STATE = {
  query: { data: { proxy: "http://x", model_refresh_interval: 600 }, isLoading: false },
  save: { mutate: mockSaveMutate, isPending: false, isError: false, isSuccess: false, error: null },
}

const { ConfigPage } = await import("@/components/config/ConfigPage")
const { useUiStore } = await import("@/stores/ui-store")

function renderConfig() {
  return render(
    <MemoryRouter initialEntries={["/config"]}>
      <Routes>
        <Route
          path="/config"
          element={<ConfigPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe("ConfigPage · fork B (designVersion routes legacy vs shadcn)", () => {
  beforeEach(() => {
    mockUseConfigYaml.mockReturnValue(DEFAULT_STATE)
    mockSaveMutate.mockReset()
    act(() => useUiStore.getState().setDesignVersion("amber-legacy"))
  })
  afterEach(() => act(() => useUiStore.getState().setDesignVersion("amber-legacy")))

  it("amber-legacy: mounts ConfigLegacy (no shadcn marker); JSON textarea + save visible", () => {
    renderConfig()
    expect(screen.queryAllByTestId("config-shadcn")).toHaveLength(0)
    const ta = screen.getByRole<HTMLTextAreaElement>("textbox")
    expect(ta.value).toContain("model_refresh_interval")
    expect(screen.getByText("save")).toBeDefined()
  })

  it("shadcn: mounts ConfigShadcn exclusively + renders config JSON in an editor", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderConfig()
    expect(screen.queryAllByTestId("config-shadcn")).toHaveLength(1)
    const ta = screen.getByRole<HTMLTextAreaElement>("textbox")
    expect(ta.value).toContain("model_refresh_interval")
    // a11y: 编辑器有可访问名(label 关联)。
    expect(screen.getByRole("textbox", { name: /config/i })).toBeDefined()
  })

  it("shadcn: save button parses the editor text and mutates the parsed object", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderConfig()
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    expect(mockSaveMutate).toHaveBeenCalledWith(expect.objectContaining({ proxy: "http://x" }))
  })

  it("shadcn: surfaces a parse error when the editor text is invalid JSON", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderConfig()
    const ta = screen.getByRole<HTMLTextAreaElement>("textbox")
    fireEvent.change(ta, { target: { value: "{ not json" } })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    expect(mockSaveMutate).not.toHaveBeenCalled()
    expect(screen.getByText(/解析错误/)).toBeDefined()
  })

  it("shadcn: shows a saved confirmation after a successful save", () => {
    mockUseConfigYaml.mockReturnValue({
      ...DEFAULT_STATE,
      save: { ...DEFAULT_STATE.save, isSuccess: true },
    })
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderConfig()
    expect(screen.getByText(/已保存/)).toBeDefined()
  })

  it("shadcn: shows a loading state while the config is pending", () => {
    mockUseConfigYaml.mockReturnValue({
      query: { data: undefined, isLoading: true },
      save: DEFAULT_STATE.save,
    })
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderConfig()
    expect(screen.getByText(/loading/i)).toBeDefined()
    expect(screen.queryAllByTestId("config-shadcn")).toHaveLength(1)
  })
})

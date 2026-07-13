/**
 * ModelsShadcn fork-routed 测试(P4 §8.2,决策 8 + 决策 10)——渲染真实 `ModelsPage`(DesignFork),
 * 由 `designVersion` 决定挂 legacy(`ModelDetail` 竖排 ModelDetailSubRail 抽屉)vs shadcn(`ModelDetailShadcn`
 * 抽屉 + 顶部水平 HorizontalTabs 6 tab)。shadcn 分支断言:互斥挂载(models-shadcn 唯一)+ 表格行 +
 * `?model=` 选中开抽屉 + 抽屉水平 6 tab(名 = MODEL_DETAIL_TABS)+ tab 内容体逐字复用(B)+ 抽屉覆盖不卸载列表。
 * amber-legacy 分支断言竖排 sub-rail。
 */
import {
  //
  act,
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

const DEFAULT_MODELS_RESULT = {
  data: {
    data: [
      {
        id: "claude-opus-4.8",
        name: "Opus",
        vendor: "Anthropic",
        version: "4.8",
        capabilities: { type: "chat", supports: { vision: true }, limits: { max_context_window_tokens: 1_000_000 } },
        billing: { multiplier: 3 },
      },
      { id: "gpt-5.5", name: "GPT", vendor: "OpenAI", version: "5.5", capabilities: { type: "chat", supports: {}, limits: {} }, billing: { multiplier: 1 } },
    ],
  },
  isLoading: false,
  isError: false,
  error: null,
}

vi.mock("@/hooks/useModels", () => ({ useModels: () => DEFAULT_MODELS_RESULT }))
vi.mock("@/hooks/useModelTelemetry", () => ({ useModelTelemetry: () => ({ data: { modelsSinceStart: [], modelsLast7d: [] } }) }))

const { ModelsPage } = await import("@/components/models/ModelsPage")
const { useUiStore } = await import("@/stores/ui-store")

/** 6 tab(顺序 = legacy MODEL_DETAIL_TABS),shadcn 水平 tab 名逐一对齐。 */
const MODEL_DETAIL_TABS = ["Overview", "Capabilities", "Limits + Vision", "Billing + Policy", "Telemetry", "Raw JSON"] as const

function renderModels(initialEntries: Array<string> = ["/models"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <ModelsPage />
    </MemoryRouter>,
  )
}

describe("ModelsPage · fork B (designVersion routes legacy vs shadcn)", () => {
  beforeEach(() => {
    localStorage.clear()
    act(() => useUiStore.getState().setDesignVersion("amber-legacy"))
  })
  afterEach(() => act(() => useUiStore.getState().setDesignVersion("amber-legacy")))

  it("amber-legacy: mounts legacy (no shadcn marker); detail drawer uses a VERTICAL sub-rail", () => {
    renderModels()
    expect(screen.queryAllByTestId("models-shadcn")).toHaveLength(0)
    // 打开 legacy 抽屉(id cell 是 keyboard-reachable button)。
    fireEvent.click(screen.getByRole("button", { name: /Open details for claude-opus-4\.8/i }))
    const tablist = screen.getByRole("tablist", { name: "Model detail sections" })
    expect(tablist.dataset.orientation).toBe("vertical")
  })

  it("shadcn: mounts ModelsShadcn exclusively (legacy absent) + renders table rows", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderModels()
    expect(screen.queryAllByTestId("models-shadcn")).toHaveLength(1)
    expect(screen.getByText("claude-opus-4.8")).toBeDefined()
    expect(screen.getByText("gpt-5.5")).toBeDefined()
    expect(screen.getByText(/Models · 2\/2/)).toBeDefined()
  })

  it("shadcn: row click opens the detail DRAWER with a HORIZONTAL 6-tab list (decision 8 + 10)", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderModels()
    expect(screen.queryByRole("dialog")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Open details for claude-opus-4\.8/i }))
    // 抽屉是 Radix Dialog,role=dialog 命名于 title(model id)。
    expect(screen.getByRole("dialog", { name: /claude-opus-4\.8/i })).toBeDefined()
    // 决策 10:竖排 sub-rail → 顶部水平 Tabs。
    const tablist = screen.getByRole("tablist", { name: "Model detail sections" })
    expect(tablist.dataset.orientation).toBe("horizontal")
    // 6 段全在(名 = MODEL_DETAIL_TABS)。
    expect(screen.getAllByRole("tab")).toHaveLength(6)
    for (const name of MODEL_DETAIL_TABS) expect(screen.getByRole("tab", { name })).toBeDefined()
  })

  it("shadcn: active tabpanel reuses the (B) detail-tab content body verbatim (Overview default)", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderModels()
    fireEvent.click(screen.getByRole("button", { name: /Open details for claude-opus-4\.8/i }))
    // 默认 active = Overview;OverviewTab 渲染 vendor(与 legacy 同一内容体)。
    expect(screen.getAllByText(/Anthropic/).length).toBeGreaterThan(0)
  })

  it("shadcn: `?model=<id>` deep link opens the drawer on mount", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderModels(["/models?model=gpt-5.5"])
    expect(screen.getByRole("dialog", { name: /gpt-5\.5/i })).toBeDefined()
  })

  it("shadcn: drawer overlays (does not unmount) the list — a non-selected row stays present", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderModels()
    fireEvent.click(screen.getByRole("button", { name: /Open details for claude-opus-4\.8/i }))
    expect(screen.getByRole("dialog", { name: /claude-opus-4\.8/i })).toBeDefined()
    // 列表仍挂载(gpt-5.5 行还在);Radix 把背景标 aria-hidden,包含 hidden 节点断言。
    expect(screen.getByText("gpt-5.5", { hidden: true } as never)).toBeDefined()
  })

  it("shadcn: closing the drawer via × clears selection (drawer unmounts)", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderModels()
    fireEvent.click(screen.getByRole("button", { name: /Open details for claude-opus-4\.8/i }))
    expect(screen.getByRole("dialog", { name: /claude-opus-4\.8/i })).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: /Close model detail/i }))
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

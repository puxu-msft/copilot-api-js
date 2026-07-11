/**
 * Learned fork-routed 测试(P7 §8.2)——渲染真实 `LearnedPage`(DesignFork),由 `designVersion`
 * 决定挂 legacy(Terminal Amber 页元素)vs shadcn(重设计页壳)。
 * shadcn 分支断言:互斥挂载(`learned-shadcn` 唯一)+ 复用 B 内容体(`LearnedRow` 富行 / `StatusBadge`)
 * 逐字呈现 + 分类分组/计数/TTL + 筛选(active/expired/pinned)+ 整体导出(getBlob + triggerDownload)
 * + 空态 + loading。amber-legacy 分支断 legacy 内容仍在、shadcn 标记缺席(INV-2 互斥挂载)。
 */
import {
  //
  act,
  fireEvent,
  render,
  screen,
  waitFor,
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

import type {
  //
  EntryStatus,
  LearnedEntryView,
  LearnedSnapshot,
  NegotiationCategory,
} from "@/types"

// drivable mocks(vi.hoisted 使 fn 在 hoisted vi.mock factory 前存在)——各测试覆写 snapshot/mutation。
const { mockUseLearned, renewMutate, removeMutate, getBlobMock, triggerDownloadMock } = vi.hoisted(() => ({
  mockUseLearned: vi.fn(),
  renewMutate: vi.fn(),
  removeMutate: vi.fn(),
  getBlobMock: vi.fn(),
  triggerDownloadMock: vi.fn(),
}))

vi.mock("@/hooks/useLearned", () => ({ useLearned: () => mockUseLearned() }))
vi.mock("@/lib/api", () => ({ api: { getBlob: getBlobMock } }))
vi.mock("@/lib/export-entry", () => ({ triggerDownload: triggerDownloadMock }))
vi.stubGlobal("confirm", () => true)

function mkEntry(over: Partial<LearnedEntryView> & { category: NegotiationCategory; value: string }): LearnedEntryView {
  return {
    key: "url|opus",
    firstLearnedAt: 0,
    lastConfirmedAt: 0,
    expiresAt: 2_592_000_000,
    status: "active" as EntryStatus,
    pinned: false,
    migrated: false,
    ...over,
  }
}

const baseSnapshot: LearnedSnapshot = {
  categories: [
    {
      category: "features",
      ttlMs: 2_592_000_000,
      entries: [mkEntry({ category: "features", key: "url|opus", value: "context_management" })],
    },
    { category: "betas", ttlMs: 2_592_000_000, entries: [] },
  ],
}

function state(snapshot: LearnedSnapshot | undefined, isLoading = false) {
  return {
    query: { data: snapshot, isLoading },
    renew: { mutate: renewMutate, isPending: false },
    expire: { mutate: vi.fn(), isPending: false },
    setPin: { mutate: vi.fn(), isPending: false },
    remove: { mutate: removeMutate, isPending: false },
  }
}

const { LearnedPage } = await import("@/components/learned/LearnedPage")
const { useUiStore } = await import("@/stores/ui-store")

function renderLearned() {
  return render(
    <MemoryRouter initialEntries={["/learned"]}>
      <Routes>
        <Route
          path="/learned"
          element={<LearnedPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe("LearnedPage · fork B (designVersion routes legacy vs shadcn)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseLearned.mockReturnValue(state(baseSnapshot))
    act(() => useUiStore.getState().setDesignVersion("amber-legacy"))
  })
  afterEach(() => act(() => useUiStore.getState().setDesignVersion("amber-legacy")))

  it("amber-legacy: mounts LearnedLegacy (no shadcn marker); category + row visible", () => {
    renderLearned()
    expect(screen.queryAllByTestId("learned-shadcn")).toHaveLength(0)
    expect(screen.getByText("context_management")).toBeDefined()
    expect(screen.getByText("anthropic-beta 头")).toBeDefined()
  })

  it("shadcn: mounts LearnedShadcn exclusively + reuses LearnedRow (B) rows verbatim", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderLearned()
    expect(screen.queryAllByTestId("learned-shadcn")).toHaveLength(1)
    // 复用 B 内容体 LearnedRow / StatusBadge:富行 + 状态徽章可见。
    expect(screen.getByText("context_management")).toBeDefined()
    expect(screen.getByText("● 活跃")).toBeDefined()
    // 默认视图展示所有分类,含 0 条空分类(分类名 + TTL)。
    expect(screen.getByText("请求体字段（Extra inputs）")).toBeDefined()
    expect(screen.getByText("anthropic-beta 头")).toBeDefined()
  })

  it("shadcn: row action mutations round-trip the RAW ref via reused LearnedRow", () => {
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderLearned()
    fireEvent.click(screen.getByText("续约"))
    expect(renewMutate).toHaveBeenCalledWith({ category: "features", key: "url|opus", value: "context_management" })
  })

  it("shadcn: expired filter surfaces manually_expired rows and hides active ones", () => {
    mockUseLearned.mockReturnValue(
      state({
        categories: [
          {
            category: "features",
            ttlMs: 2_592_000_000,
            entries: [
              mkEntry({ category: "features", value: "active_feature", status: "active" }),
              mkEntry({ category: "features", value: "expired_feature", status: "manually_expired" }),
            ],
          },
        ],
      }),
    )
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderLearned()
    expect(screen.getByText("active_feature")).toBeDefined()
    expect(screen.getByText("expired_feature")).toBeDefined()
    // "已过期" 筛选合并 expired | manually_expired。
    fireEvent.click(screen.getByRole("button", { name: "已过期" }))
    expect(screen.queryByText("active_feature")).toBeNull()
    expect(screen.getByText("expired_feature")).toBeDefined()
  })

  it("shadcn: 整体导出 fetches the export blob and triggers a download", async () => {
    const blob = new Blob(["{}"], { type: "application/json" })
    getBlobMock.mockResolvedValueOnce(blob)
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderLearned()
    fireEvent.click(screen.getByRole("button", { name: /整体导出/ }))
    await waitFor(() => expect(triggerDownloadMock).toHaveBeenCalledWith(blob, "negotiation-states.json"))
    expect(getBlobMock).toHaveBeenCalledWith("/api/negotiation/export")
  })

  it("shadcn: renders an empty state when there are no categories", () => {
    mockUseLearned.mockReturnValue(state({ categories: [] }))
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderLearned()
    expect(screen.queryAllByTestId("learned-shadcn")).toHaveLength(1)
    expect(screen.getByText(/无记录/)).toBeDefined()
  })

  it("shadcn: shows a loading state while the snapshot is pending", () => {
    mockUseLearned.mockReturnValue(state(undefined, true))
    act(() => useUiStore.getState().setDesignVersion("shadcn"))
    renderLearned()
    expect(screen.getByText(/loading/i)).toBeDefined()
    expect(screen.queryAllByTestId("learned-shadcn")).toHaveLength(1)
  })
})

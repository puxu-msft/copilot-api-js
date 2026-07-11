/**
 * `useLearnedView` 单测(P7 review 范式 · drift 守卫)——直接验证抽出的视图编排 primitive
 * (filter 状态 / `matches` 状态匹配 / `groups` 派生 / 整体导出),使跨 legacy·shadcn 两树的同构
 * 不再靠 copy-paste + 组件级测试维持,而有独立断言层。对齐 P5 `group-by-agent.vitest` /
 * P6 `useConfigEditor.vitest` 范式。
 */
import {
  //
  act,
  renderHook,
  waitFor,
} from "@testing-library/react"
import {
  //
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

const { mockUseLearned, getBlobMock, triggerDownloadMock } = vi.hoisted(() => ({
  mockUseLearned: vi.fn(),
  getBlobMock: vi.fn(),
  triggerDownloadMock: vi.fn(),
}))

vi.mock("@/hooks/useLearned", () => ({ useLearned: () => mockUseLearned() }))
vi.mock("@/lib/api", () => ({ api: { getBlob: getBlobMock } }))
vi.mock("@/lib/export-entry", () => ({ triggerDownload: triggerDownloadMock }))

function mkEntry(over: Partial<LearnedEntryView> & { category: NegotiationCategory; value: string }): LearnedEntryView {
  return {
    key: "k",
    firstLearnedAt: 0,
    lastConfirmedAt: 0,
    expiresAt: 2_592_000_000,
    status: "active" as EntryStatus,
    pinned: false,
    migrated: false,
    ...over,
  }
}

const snapshot: LearnedSnapshot = {
  categories: [
    {
      category: "features",
      ttlMs: 2_592_000_000,
      entries: [
        mkEntry({ category: "features", value: "active_feature", status: "active" }),
        mkEntry({ category: "features", value: "expired_feature", status: "manually_expired" }),
      ],
    },
    // 空分类:默认视图保留、筛选视图裁掉。
    { category: "betas", ttlMs: 2_592_000_000, entries: [] },
  ],
}

function state(data: LearnedSnapshot | undefined, isLoading = false) {
  return {
    query: { data, isLoading },
    renew: { mutate: vi.fn(), isPending: false },
    expire: { mutate: vi.fn(), isPending: false },
    setPin: { mutate: vi.fn(), isPending: false },
    remove: { mutate: vi.fn(), isPending: false },
  }
}

const { useLearnedView } = await import("@/hooks/useLearnedView")

describe("useLearnedView", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseLearned.mockReturnValue(state(snapshot))
  })

  it("default (all) view keeps every category incl. empty ones", () => {
    const { result } = renderHook(() => useLearnedView())
    expect(result.current.filter).toBe("all")
    expect(result.current.groups).toHaveLength(2)
    expect(result.current.groups[0].entries).toHaveLength(2)
    // 空分类 betas 仍在。
    expect(result.current.groups[1].category).toBe("betas")
    expect(result.current.groups[1].entries).toHaveLength(0)
    expect(result.current.isLoading).toBe(false)
  })

  it("expired filter merges expired | manually_expired and drops empty categories", () => {
    const { result } = renderHook(() => useLearnedView())
    act(() => result.current.setFilter("expired"))
    // 空分类被裁掉,只留有匹配条目的分类。
    expect(result.current.groups).toHaveLength(1)
    const values = result.current.groups[0].entries.map((e) => e.value)
    expect(values).toEqual(["expired_feature"])
  })

  it("active filter surfaces only active rows", () => {
    const { result } = renderHook(() => useLearnedView())
    act(() => result.current.setFilter("active"))
    expect(result.current.groups[0].entries.map((e) => e.value)).toEqual(["active_feature"])
  })

  it("pinned filter keeps only pinned rows and drops empty categories", () => {
    mockUseLearned.mockReturnValue(
      state({
        categories: [
          {
            category: "features",
            ttlMs: 2_592_000_000,
            entries: [
              mkEntry({ category: "features", value: "pinned_feature", status: "pinned", pinned: true }),
              mkEntry({ category: "features", value: "active_feature", status: "active" }),
            ],
          },
          { category: "betas", ttlMs: 2_592_000_000, entries: [] },
        ],
      }),
    )
    const { result } = renderHook(() => useLearnedView())
    act(() => result.current.setFilter("pinned"))
    // 空分类被裁掉,只留有 pinned 匹配条目的分类。
    expect(result.current.groups).toHaveLength(1)
    expect(result.current.groups[0].entries.map((e) => e.value)).toEqual(["pinned_feature"])
  })

  it("onExport fetches the blob and triggers a download", async () => {
    const blob = new Blob(["{}"], { type: "application/json" })
    getBlobMock.mockResolvedValueOnce(blob)
    const { result } = renderHook(() => useLearnedView())
    await act(async () => {
      await result.current.onExport()
    })
    await waitFor(() => expect(triggerDownloadMock).toHaveBeenCalledWith(blob, "negotiation-states.json"))
    expect(getBlobMock).toHaveBeenCalledWith("/api/negotiation/export")
  })

  it("reflects the loading state and yields no groups while pending", () => {
    mockUseLearned.mockReturnValue(state(undefined, true))
    const { result } = renderHook(() => useLearnedView())
    expect(result.current.isLoading).toBe(true)
    expect(result.current.groups).toHaveLength(0)
  })
})

import {
  //
  fireEvent,
  render,
  screen,
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

const renewMutate = vi.fn()
const removeMutate = vi.fn()
const getBlobMock = vi.fn()
const triggerDownloadMock = vi.fn()

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

// The active snapshot the mocked hook returns; each test may override it before render.
let activeSnapshot: LearnedSnapshot = baseSnapshot

vi.mock("@/hooks/useLearned", () => ({
  useLearned: () => ({
    query: { data: activeSnapshot, isLoading: false },
    renew: { mutate: renewMutate, isPending: false },
    expire: { mutate: vi.fn(), isPending: false },
    setPin: { mutate: vi.fn(), isPending: false },
    remove: { mutate: removeMutate, isPending: false },
  }),
}))
vi.mock("@/lib/api", () => ({ api: { getBlob: getBlobMock } }))
vi.mock("@/lib/export-entry", () => ({ triggerDownload: triggerDownloadMock }))
vi.stubGlobal("confirm", () => true)

const { LearnedPage } = await import("@/components/learned/LearnedPage")

beforeEach(() => {
  vi.clearAllMocks()
  activeSnapshot = baseSnapshot
})

describe("LearnedPage", () => {
  it("renders all rule categories in the default view, incl. empty ones", () => {
    render(<LearnedPage />)
    expect(screen.getByText("context_management")).toBeDefined()
    // empty 'betas' category is still shown (header + 无记录 placeholder), not hidden
    expect(screen.getByText("anthropic-beta 头")).toBeDefined()
    expect(screen.getAllByText("无记录").length).toBeGreaterThan(0)
  })
  it("renew action calls mutation", () => {
    render(<LearnedPage />)
    fireEvent.click(screen.getByText("续约"))
    expect(renewMutate).toHaveBeenCalledWith({ category: "features", key: "url|opus", value: "context_management" })
  })
  it("delete action calls mutation after confirm", () => {
    render(<LearnedPage />)
    fireEvent.click(screen.getByText("删除"))
    expect(removeMutate).toHaveBeenCalled()
  })

  it("整体导出 fetches the backend export blob and triggers a download", async () => {
    const blob = new Blob(["{}"], { type: "application/json" })
    getBlobMock.mockResolvedValueOnce(blob)
    render(<LearnedPage />)
    fireEvent.click(screen.getByText("整体导出"))
    await waitFor(() => expect(triggerDownloadMock).toHaveBeenCalledWith(blob, "negotiation-states.json"))
    expect(getBlobMock).toHaveBeenCalledWith("/api/negotiation/export")
  })

  it("expired filter surfaces manually_expired rows and hides active ones", () => {
    activeSnapshot = {
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
    }
    render(<LearnedPage />)
    // Both visible before filtering.
    expect(screen.getByText("active_feature")).toBeDefined()
    expect(screen.getByText("expired_feature")).toBeDefined()
    // The "expired" filter renders as the localized label "已过期" (§4.5).
    fireEvent.click(screen.getByText("已过期"))
    expect(screen.queryByText("active_feature")).toBeNull()
    // manually_expired surfaces under the merged 已过期 filter.
    expect(screen.getByText("expired_feature")).toBeDefined()
  })

  it("shows the stripped bare model but round-trips the RAW modelKey to the mutation", () => {
    const rawModelKey = "https://x|anthropic-messages|claude-sonnet-4.6"
    activeSnapshot = {
      categories: [
        {
          category: "systemRejectModels",
          ttlMs: 2_592_000_000,
          entries: [mkEntry({ category: "systemRejectModels", key: "", value: rawModelKey })],
        },
      ],
    }
    render(<LearnedPage />)
    // Visible text is the stripped bare model.
    expect(screen.getByText("claude-sonnet-4.6")).toBeDefined()
    expect(screen.queryByText(rawModelKey)).toBeNull()
    // The action mutation carries the RAW modelKey, not the stripped display value.
    fireEvent.click(screen.getByText("续约"))
    expect(renewMutate).toHaveBeenCalledWith({ category: "systemRejectModels", key: "", value: rawModelKey })
  })
})

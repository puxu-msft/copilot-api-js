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
  vi,
} from "vitest"

const renewMutate = vi.fn()
const removeMutate = vi.fn()
const snapshot = {
  categories: [
    {
      category: "features",
      ttlMs: 2_592_000_000,
      entries: [
        {
          category: "features",
          key: "url|opus",
          value: "context_management",
          firstLearnedAt: 0,
          lastConfirmedAt: 0,
          expiresAt: 2_592_000_000,
          status: "active",
          pinned: false,
          migrated: false,
        },
      ],
    },
    { category: "betas", ttlMs: 2_592_000_000, entries: [] },
  ],
}
vi.mock("@/hooks/useLearned", () => ({
  useLearned: () => ({
    query: { data: snapshot, isLoading: false },
    renew: { mutate: renewMutate, isPending: false },
    expire: { mutate: vi.fn(), isPending: false },
    setPin: { mutate: vi.fn(), isPending: false },
    remove: { mutate: removeMutate, isPending: false },
  }),
}))
vi.stubGlobal("confirm", () => true)

const { LearnedPage } = await import("@/components/learned/LearnedPage")

describe("LearnedPage", () => {
  it("renders grouped entries and hides empty groups", () => {
    render(<LearnedPage />)
    expect(screen.getByText("context_management")).toBeDefined()
    // empty 'betas' group hidden
    expect(screen.queryByText("anthropic-beta 头")).toBeNull()
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
})

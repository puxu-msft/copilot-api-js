import {
  //
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import {
  //
  renderHook,
  waitFor,
} from "@testing-library/react"
import {
  //
  describe,
  expect,
  it,
  vi,
} from "vitest"

const get = vi.fn().mockResolvedValue({ categories: [] })
const post = vi.fn().mockResolvedValue({ ok: true })
vi.mock("@/lib/api", () => ({ api: { get, post } }))

const { useLearned } = await import("@/hooks/useLearned")

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

describe("useLearned", () => {
  it("fetches snapshot and exposes mutations", async () => {
    const { result } = renderHook(() => useLearned(), { wrapper })
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledWith("/api/negotiation")
    result.current.renew.mutate({ category: "features", key: "k", value: "v" })
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/negotiation/renew", { category: "features", key: "k", value: "v" }))
  })
})

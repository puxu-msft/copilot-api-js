import {
  //
  describe,
  expect,
  it,
  mock,
} from "bun:test"

import {
  //
  ApiError,
  createApi,
} from "@/lib/api"

describe("api client", () => {
  it("builds history path and parses json", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ total: 7 }), { status: 200 }))
    const api = createApi(fetchMock as unknown as typeof fetch)
    const res = await api.get<{ total: number }>("/history/api/stats")
    expect(res.total).toBe(7)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("throws ApiError with status on non-ok", async () => {
    const fetchMock = mock(async () => new Response("boom", { status: 500 }))
    const api = createApi(fetchMock as unknown as typeof fetch)
    await expect(api.get("/history/api/stats")).rejects.toBeInstanceOf(ApiError)
  })

  it("put sends body and parses json", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const api = createApi(fetchMock as unknown as typeof fetch)
    const res = await api.put<{ ok: boolean }>("/api/config/yaml", { a: 1 })
    expect(res.ok).toBe(true)
  })
})

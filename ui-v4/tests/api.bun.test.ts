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

  it("getBlob returns the raw body as a Blob", async () => {
    const fetchMock = mock(async () => new Response(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]), { status: 200, headers: { "content-type": "application/zstd" } }))
    const api = createApi(fetchMock as unknown as typeof fetch)
    const blob = await api.getBlob("/history/api/entries/req_1/export")
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.size).toBe(4)
  })

  it("getBlob throws ApiError on non-ok", async () => {
    const fetchMock = mock(async () => new Response("nope", { status: 404 }))
    const api = createApi(fetchMock as unknown as typeof fetch)
    await expect(api.getBlob("/history/api/entries/x/export")).rejects.toBeInstanceOf(ApiError)
  })
})

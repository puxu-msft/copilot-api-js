import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { HistoryEntry } from "@/types"

// Mock the API layer + toast so the util is exercised in isolation (no real fetch / no component context).
const fetchEntryExport = vi.fn<(id: string) => Promise<Blob>>()
const show = vi.fn<(text: string, type?: string) => void>()

vi.mock("@/api/http", () => ({ api: { fetchEntryExport: (id: string) => fetchEntryExport(id) } }))
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ show }) }))

import { downloadEntryAsZst } from "@/utils/export-entry"

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "req_123",
    startedAt: Date.now(),
    endpoint: "anthropic-messages",
    clientRequest: { model: "claude-opus-4.8" },
    ...overrides,
  } as HistoryEntry
}

describe("downloadEntryAsZst", () => {
  let click: ReturnType<typeof vi.fn>
  let created: HTMLAnchorElement | null

  beforeEach(() => {
    fetchEntryExport.mockReset()
    show.mockReset()
    created = null
    click = vi.fn()
    globalThis.URL.createObjectURL = vi.fn(() => "blob:mock")
    globalThis.URL.revokeObjectURL = vi.fn()
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = { tagName: tag, href: "", download: "", click } as unknown as HTMLAnchorElement
      created = el
      return el
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("downloads the compressed blob under <id>_<model>.json.zst", async () => {
    fetchEntryExport.mockResolvedValue(new Blob(["zst-bytes"]))

    await downloadEntryAsZst(makeEntry())

    expect(fetchEntryExport).toHaveBeenCalledWith("req_123")
    expect(created?.download).toBe("req_123_claude-opus-4.8.json.zst")
    expect(click).toHaveBeenCalledOnce()
    expect(show).not.toHaveBeenCalled()
  })

  it("prefers the response model over the request model for the filename", async () => {
    fetchEntryExport.mockResolvedValue(new Blob(["zst"]))

    await downloadEntryAsZst(
      makeEntry({ attempts: [{ index: 0, durationMs: 0, upstreamResponse: { success: true, model: "claude-sonnet-4.6", body: null } }] } as Partial<HistoryEntry>),
    )

    expect(created?.download).toBe("req_123_claude-sonnet-4.6.json.zst")
  })

  it("surfaces a toast on failure instead of throwing", async () => {
    fetchEntryExport.mockRejectedValue(new Error("404: Entry not found"))

    await expect(downloadEntryAsZst(makeEntry())).resolves.toBeUndefined()

    expect(click).not.toHaveBeenCalled()
    expect(show).toHaveBeenCalledWith(expect.stringContaining("Export failed: 404: Entry not found"), "error")
  })
})

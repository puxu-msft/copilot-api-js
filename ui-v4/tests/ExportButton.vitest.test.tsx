import {
  //
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import {
  //
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { HistoryEntry } from "@/types"

const downloadEntryAsZst = vi.fn<(entry: HistoryEntry) => Promise<void>>()
vi.mock("@/lib/export-entry", () => ({ downloadEntryAsZst: (entry: HistoryEntry) => downloadEntryAsZst(entry) }))

import { ExportButton } from "@/components/detail/ExportButton"

const entry = { id: "req_1", startedAt: 0, endpoint: "anthropic-messages", inboundRequest: { model: "claude-opus-4.8" } } as HistoryEntry

describe("ExportButton", () => {
  it("invokes the export and returns to idle on success", async () => {
    downloadEntryAsZst.mockResolvedValue(undefined)
    render(<ExportButton entry={entry} />)

    fireEvent.click(screen.getByRole("button"))

    await waitFor(() => expect(downloadEntryAsZst).toHaveBeenCalledWith(entry))
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("Export .zst"))
  })

  it("shows a failure label when the export rejects", async () => {
    downloadEntryAsZst.mockRejectedValue(new Error("404"))
    render(<ExportButton entry={entry} />)

    fireEvent.click(screen.getByRole("button"))

    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("Export failed"))
  })
})

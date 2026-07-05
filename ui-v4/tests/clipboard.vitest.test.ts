import {
  //
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { copyText } from "@/lib/clipboard"

describe("copyText", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("writes to navigator.clipboard and reports success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })

    const ok = await copyText("hello")

    expect(ok).toBe(true)
    expect(writeText).toHaveBeenCalledWith("hello")
  })

  it("reports failure when the clipboard write rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"))
    vi.stubGlobal("navigator", { clipboard: { writeText } })

    const ok = await copyText("hello")

    expect(ok).toBe(false)
  })

  it("reports failure when no clipboard API is available", async () => {
    vi.stubGlobal("navigator", {})

    const ok = await copyText("hello")

    expect(ok).toBe(false)
  })
})

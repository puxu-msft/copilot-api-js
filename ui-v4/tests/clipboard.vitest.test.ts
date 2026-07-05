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
    // jsdom has no execCommand; remove any we defined so tests stay isolated.
    Reflect.deleteProperty(document, "execCommand")
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

  it("falls back to execCommand when the async clipboard API is absent", async () => {
    vi.stubGlobal("navigator", {})
    const execCommand = vi.fn().mockReturnValue(true)
    // jsdom doesn't implement execCommand, so define it rather than spy on it.
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true })

    const ok = await copyText("hello")

    expect(ok).toBe(true)
    expect(execCommand).toHaveBeenCalledWith("copy")
  })

  it("reports failure when neither clipboard API nor execCommand works", async () => {
    vi.stubGlobal("navigator", {})
    Object.defineProperty(document, "execCommand", { value: vi.fn().mockReturnValue(false), configurable: true })

    const ok = await copyText("hello")

    expect(ok).toBe(false)
  })
})

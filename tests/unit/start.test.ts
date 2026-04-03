import { afterEach, describe, expect, mock, test } from "bun:test"

import { startModelRefreshLoop, syncModelRefreshLoop } from "~/lib/models/refresh-loop"
import { restoreStateForTests, setStateForTests, snapshotStateForTests } from "~/lib/state"

describe("startModelRefreshLoop", () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const originalState = snapshotStateForTests()

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    restoreStateForTests(originalState)
  })

  test("schedules periodic model refresh using the configured interval and returns a cleanup function", async () => {
    setStateForTests({ modelRefreshInterval: 123 })

    let scheduled: (() => void) | undefined
    const timeoutHandle = { id: 1 } as unknown as ReturnType<typeof setTimeout>
    const setTimeoutMock = mock((fn: () => void, _delay?: number) => {
      scheduled = fn
      return timeoutHandle
    })
    const clearTimeoutMock = mock(() => {})
    const refreshMock = mock(async () => {})

    globalThis.setTimeout = setTimeoutMock as unknown as typeof setTimeout
    globalThis.clearTimeout = clearTimeoutMock as unknown as typeof clearTimeout

    const stop = startModelRefreshLoop(refreshMock)

    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 123000)
    expect(scheduled).toBeDefined()

    await scheduled?.()
    expect(refreshMock).toHaveBeenCalledTimes(1)

    stop()
    expect(clearTimeoutMock).toHaveBeenCalledWith(timeoutHandle)
  })

  test("does not schedule refresh when the configured interval is zero", () => {
    setStateForTests({ modelRefreshInterval: 0 })

    const setTimeoutMock = mock(() => ({ id: 1 }))
    globalThis.setTimeout = setTimeoutMock as unknown as typeof setTimeout

    const stop = startModelRefreshLoop(async () => {})
    stop()

    expect(setTimeoutMock).not.toHaveBeenCalled()
  })

  test("syncModelRefreshLoop reschedules when the config interval changes", () => {
    setStateForTests({ modelRefreshInterval: 10 })

    const firstHandle = { id: 1 } as unknown as ReturnType<typeof setTimeout>
    const secondHandle = { id: 2 } as unknown as ReturnType<typeof setTimeout>
    const setTimeoutMock = mock().mockReturnValueOnce(firstHandle).mockReturnValueOnce(secondHandle)
    const clearTimeoutMock = mock(() => {})

    globalThis.setTimeout = setTimeoutMock as unknown as typeof setTimeout
    globalThis.clearTimeout = clearTimeoutMock as unknown as typeof clearTimeout

    const stop = startModelRefreshLoop(async () => {})
    syncModelRefreshLoop(20)
    stop()

    expect(setTimeoutMock).toHaveBeenNthCalledWith(1, expect.any(Function), 10000)
    expect(clearTimeoutMock).toHaveBeenCalledWith(firstHandle)
    expect(setTimeoutMock).toHaveBeenNthCalledWith(2, expect.any(Function), 20000)
  })
})

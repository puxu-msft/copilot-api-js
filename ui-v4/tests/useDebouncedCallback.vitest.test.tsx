import { renderHook } from "@testing-library/react"
import {
  //
  afterEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"

import { useDebouncedCallback } from "@/hooks/useDebouncedCallback"

afterEach(() => vi.useRealTimers())

describe("useDebouncedCallback", () => {
  test("coalesces rapid calls, fires once after delay with last args", () => {
    vi.useFakeTimers()
    const spy = vi.fn()
    const { result } = renderHook(() => useDebouncedCallback(spy, 300))
    result.current("a")
    result.current("b")
    result.current("c")
    expect(spy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith("c")
  })
})

import { renderHook } from "@testing-library/react"
import { act } from "react"
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { useNowTick } from "@/hooks/useNowTick"

describe("useNowTick", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("active 时每秒推进 now", () => {
    vi.setSystemTime(1000)
    const { result } = renderHook(() => useNowTick(true, 1000))
    expect(result.current).toBe(1000)
    act(() => {
      // advanceTimersByTime 会同时推进 mock 时钟,interval 触发时 Date.now() = 1000 + 1000
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(2000)
  })

  it("非 active 时不设 interval(now 不推进)", () => {
    vi.setSystemTime(1000)
    const { result } = renderHook(() => useNowTick(false, 1000))
    act(() => {
      vi.setSystemTime(2000)
      vi.advanceTimersByTime(5000)
    })
    expect(result.current).toBe(1000)
  })
})

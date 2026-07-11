import {
  //
  act,
  renderHook,
} from "@testing-library/react"
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"

import { useColumnState } from "@/hooks/useColumnState"
import {
  //
  COLUMN_STATE_KEY,
  DEFAULT_COLUMN_ORDER,
  DEFAULT_COLUMN_SIZING,
  DEFAULT_COLUMN_VISIBILITY,
} from "@/lib/request-columns"

/**
 * useColumnState —— 版本化列状态(visibility/sizing/order)统一持有 + 单键持久化。
 * jsdom 提供真实 localStorage;每例前清空以隔离。锁契约:seed 默认、写读往返、未知键回退、
 * reset 清键回默认、toggleColumn 翻转。
 */
describe("useColumnState", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it("seeds new-key defaults when nothing persisted (curated visibility + session-first order + default sizing)", () => {
    const { result } = renderHook(() => useColumnState())
    // 四列默认隐藏,余默认显。
    expect(result.current.visibility).toEqual(DEFAULT_COLUMN_VISIBILITY)
    expect(result.current.visibility.endpoint).toBe(false)
    expect(result.current.visibility.cache).toBe(true)
    // 序 session 首、覆盖全列。
    expect(result.current.order[0]).toBe("session")
    expect([...result.current.order].sort()).toEqual([...DEFAULT_COLUMN_ORDER].sort())
    // 默认 size。
    expect(result.current.sizing).toEqual(DEFAULT_COLUMN_SIZING)
  })

  it("persists visibility/sizing/order to the versioned key and round-trips on remount", () => {
    const { result, unmount } = renderHook(() => useColumnState())
    act(() => {
      result.current.setSizing({ model: 240 })
      result.current.setVisibility({ ...DEFAULT_COLUMN_VISIBILITY, endpoint: true })
    })
    // 写到 v1 键。
    const raw = JSON.parse(localStorage.getItem(COLUMN_STATE_KEY) ?? "null") as { visibility: Record<string, boolean>; sizing: Record<string, number> } | null
    expect(raw?.sizing.model).toBe(240)
    expect(raw?.visibility.endpoint).toBe(true)
    unmount()
    // 新实例读回。
    const { result: r2 } = renderHook(() => useColumnState())
    expect(r2.current.sizing.model).toBe(240)
    expect(r2.current.visibility.endpoint).toBe(true)
  })

  it("falls back to defaults when the persisted blob has unknown keys / bad shape", () => {
    localStorage.setItem(COLUMN_STATE_KEY, JSON.stringify({ visibility: { nope: false }, sizing: { nope: 999 }, order: ["nope", "status"] }))
    const { result } = renderHook(() => useColumnState())
    // 未知列丢弃 → 回默认。
    expect("nope" in result.current.visibility).toBe(false)
    expect("nope" in result.current.sizing).toBe(false)
    expect(result.current.order).not.toContain("nope")
    expect(result.current.order[0]).toBe("session")
  })

  it("tolerates corrupt JSON (seeds defaults, does not throw)", () => {
    localStorage.setItem(COLUMN_STATE_KEY, "{not json")
    const { result } = renderHook(() => useColumnState())
    expect(result.current.visibility).toEqual(DEFAULT_COLUMN_VISIBILITY)
  })

  it("toggleColumn flips a single column's visibility", () => {
    const { result } = renderHook(() => useColumnState())
    expect(result.current.visibility.bytes).toBe(true)
    act(() => result.current.toggleColumn("bytes"))
    expect(result.current.visibility.bytes).toBe(false)
    act(() => result.current.toggleColumn("bytes"))
    expect(result.current.visibility.bytes).toBe(true)
  })

  it("setOrder normalizes (session forced first) and reset clears the key back to defaults", () => {
    const { result } = renderHook(() => useColumnState())
    act(() => result.current.setOrder(["model", "session", "status"]))
    expect(result.current.order[0]).toBe("session") // session 锁首
    act(() => {
      result.current.setVisibility({ ...DEFAULT_COLUMN_VISIBILITY, bytes: false })
      result.current.reset()
    })
    expect(result.current.visibility).toEqual(DEFAULT_COLUMN_VISIBILITY)
    expect(result.current.order).toEqual([...DEFAULT_COLUMN_ORDER])
    expect(result.current.sizing).toEqual(DEFAULT_COLUMN_SIZING)
  })
})

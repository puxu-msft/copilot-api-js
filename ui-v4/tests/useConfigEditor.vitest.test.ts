/**
 * `useConfigEditor` 单测(P6 review 采纳 · drift 守卫)——直接验证抽出的编辑编排 primitive
 * (text↔query.data 同步 / JSON parse / `save.mutate` / parseError),使跨 legacy·shadcn 两树的
 * 同构不再靠 copy-paste + 组件级测试维持,而有独立断言层。对齐 P5 `group-by-agent.vitest` 范式。
 */
import {
  //
  act,
  renderHook,
} from "@testing-library/react"
import {
  //
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

const { mockUseConfigYaml, mockSaveMutate } = vi.hoisted(() => ({
  mockUseConfigYaml: vi.fn(),
  mockSaveMutate: vi.fn(),
}))

vi.mock("@/hooks/useConfigYaml", () => ({ useConfigYaml: () => mockUseConfigYaml() }))

const { useConfigEditor } = await import("@/hooks/useConfigEditor")

function baseState() {
  return {
    query: { data: { proxy: "http://x", model_refresh_interval: 600 }, isLoading: false },
    save: { mutate: mockSaveMutate, isPending: false, isError: false, isSuccess: false, error: null },
  }
}

describe("useConfigEditor", () => {
  beforeEach(() => {
    mockSaveMutate.mockReset()
    mockUseConfigYaml.mockReturnValue(baseState())
  })

  it("seeds the editor text from query.data as pretty JSON", () => {
    const { result } = renderHook(() => useConfigEditor())
    expect(result.current.text).toContain("model_refresh_interval")
    expect(result.current.isLoading).toBe(false)
    expect(result.current.parseError).toBeNull()
  })

  it("onSave parses valid JSON and mutates the parsed object", () => {
    const { result } = renderHook(() => useConfigEditor())
    act(() => result.current.onSave())
    expect(mockSaveMutate).toHaveBeenCalledWith(expect.objectContaining({ proxy: "http://x" }))
    expect(result.current.parseError).toBeNull()
  })

  it("onSave sets parseError and does not mutate on invalid JSON", () => {
    const { result } = renderHook(() => useConfigEditor())
    act(() => result.current.setText("{ not json"))
    act(() => result.current.onSave())
    expect(mockSaveMutate).not.toHaveBeenCalled()
    expect(result.current.parseError).toBeTruthy()
  })

  it("reflects the loading state from the query", () => {
    mockUseConfigYaml.mockReturnValue({ query: { data: undefined, isLoading: true }, save: baseState().save })
    const { result } = renderHook(() => useConfigEditor())
    expect(result.current.isLoading).toBe(true)
    expect(result.current.text).toBe("")
  })
})

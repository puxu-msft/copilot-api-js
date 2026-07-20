/**
 * useRequestNeighbors 测试 —— 纯计算 `neighborIds`(相邻 prev/next id,边界/缺失 null)+ hook 键盘绑定
 * (ArrowLeft/k → prev、ArrowRight/j → next,isTyping/修饰键守卫,留在详情导航 /requests/:id)。
 * design-agnostic(A 类):零 designVersion/颜色,shadcn 详情/列表复用。
 */
import {
  //
  act,
  render,
  screen,
} from "@testing-library/react"
import {
  //
  MemoryRouter,
  useLocation,
} from "react-router-dom"
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { EntrySummary } from "@/types"

let mockEntries: Array<EntrySummary> = []
vi.mock("@/hooks/useHistoryInfinite", () => ({ useHistoryInfinite: () => ({ entries: mockEntries }) }))

const { neighborIds, useRequestNeighbors } = await import("@/hooks/useRequestNeighbors")

const e = (id: string): EntrySummary => ({ id }) as unknown as EntrySummary

describe("neighborIds (pure)", () => {
  const ids = ["a", "b", "c"]
  it("middle item: prev = previous, next = following", () => {
    expect(neighborIds(ids, "b")).toEqual({ prevId: "a", nextId: "c" })
  })
  it("first item: prev null, next following", () => {
    expect(neighborIds(ids, "a")).toEqual({ prevId: null, nextId: "b" })
  })
  it("last item: prev previous, next null", () => {
    expect(neighborIds(ids, "c")).toEqual({ prevId: "b", nextId: null })
  })
  it("currentId null → both null", () => {
    expect(neighborIds(ids, null)).toEqual({ prevId: null, nextId: null })
  })
  it("currentId not in list (evicted/deep-link) → both null", () => {
    expect(neighborIds(ids, "z")).toEqual({ prevId: null, nextId: null })
  })
  it("empty list → both null", () => {
    expect(neighborIds([], "a")).toEqual({ prevId: null, nextId: null })
  })
})

function Harness({ currentId, bindKeys }: { currentId: string | null; bindKeys?: boolean }) {
  const { hasPrev, hasNext } = useRequestNeighbors(currentId, { bindKeys })
  const loc = useLocation()
  return (
    <div>
      <span data-testid="loc">{`${loc.pathname}${loc.search}`}</span>
      <span data-testid="has">{`${hasPrev ? "P" : "-"}${hasNext ? "N" : "-"}`}</span>
    </div>
  )
}

describe("useRequestNeighbors (hook + keyboard)", () => {
  beforeEach(() => {
    mockEntries = [e("a"), e("b"), e("c")]
  })
  afterEach(() => vi.restoreAllMocks())

  function renderAt(currentId: string | null, bindKeys = true) {
    return render(
      <MemoryRouter initialEntries={[`/requests/${currentId ?? ""}`]}>
        <Harness
          currentId={currentId}
          bindKeys={bindKeys}
        />
      </MemoryRouter>,
    )
  }

  it("hasPrev/hasNext reflect position (middle item)", () => {
    renderAt("b")
    expect(screen.getByTestId("has").textContent).toBe("PN")
  })

  it("ArrowRight / j navigates to next neighbor (stays in detail /requests/:id)", () => {
    renderAt("b")
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }))
    })
    expect(screen.getByTestId("loc").textContent).toBe("/requests/c")
  })

  it("ArrowLeft / k navigates to previous neighbor", () => {
    renderAt("b")
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }))
    })
    expect(screen.getByTestId("loc").textContent).toBe("/requests/a")
  })

  it("at last item: ArrowRight is a no-op (no next)", () => {
    renderAt("c")
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }))
    })
    expect(screen.getByTestId("loc").textContent).toBe("/requests/c")
  })

  it("bindKeys=false: keyboard does not navigate", () => {
    renderAt("b", false)
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }))
    })
    expect(screen.getByTestId("loc").textContent).toBe("/requests/b")
  })
})

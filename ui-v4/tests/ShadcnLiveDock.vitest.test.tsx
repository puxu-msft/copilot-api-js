/**
 * ShadcnLiveDock 呈现层测试(决策 7)—— 读同一常驻 live-store,填成完整:idle 条 / 展开分组明细 /
 * Escape 收起 / tail 开关 + 待合入 CTA(列表专属)。中性化孪生 legacy `LiveDock`(LiveDock.vitest 对偶)。
 */
import {
  //
  render,
  screen,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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
} from "vitest"

import type { LiveEntry } from "@/stores/live-store"

import { ShadcnLiveDock } from "@/components/shell/shadcn/ShadcnLiveDock"
import {
  //
  initialListState,
  useListStore,
} from "@/stores/list-store"
import { useLiveStore } from "@/stores/live-store"

const row = (id: string, over: Partial<LiveEntry> = {}): LiveEntry =>
  ({ id, endpoint: "anthropic-messages", state: "streaming", startTime: Date.now() - 3000, model: "claude", stream: true, ...over }) as LiveEntry

function seed(rows: Array<LiveEntry>) {
  useLiveStore.setState({ byId: Object.fromEntries(rows.map((r) => [r.id, r])) })
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>
}

describe("ShadcnLiveDock", () => {
  beforeEach(() => {
    useLiveStore.setState({ byId: {} })
    useListStore.setState({ ...initialListState })
    localStorage.clear()
  })
  afterEach(() => {
    useLiveStore.setState({ byId: {} })
    useListStore.setState({ ...initialListState })
  })

  it("idle 态显纤细空闲条", () => {
    render(
      <MemoryRouter>
        <ShadcnLiveDock />
      </MemoryRouter>,
    )
    expect(screen.getByText(/idle/i)).toBeTruthy()
    expect(screen.getByTestId("dock-shadcn")).toBeTruthy()
  })

  it("有在途:折叠条显 in-flight 计数,点击展开出明细", async () => {
    seed([row("a"), row("b", { state: "pending", stream: false })])
    render(
      <MemoryRouter>
        <ShadcnLiveDock />
      </MemoryRouter>,
    )
    expect(screen.getByText(/2 in-flight/)).toBeTruthy()
    expect(screen.queryByText(/anthropic/)).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: /in-flight/i }))
    expect(screen.getAllByText(/anthropic/).length).toBeGreaterThan(0)
  })

  it("展开态 Escape 收起", async () => {
    seed([row("a")])
    render(
      <MemoryRouter>
        <ShadcnLiveDock />
      </MemoryRouter>,
    )
    await userEvent.click(screen.getByRole("button", { name: /in-flight/i }))
    expect(screen.getAllByText(/anthropic/).length).toBeGreaterThan(0)
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByText(/anthropic/)).toBeNull()
  })

  it("tail 暂停且有 buffered:显「待合入」CTA,点击 flush 合入并恢复 tail + 清 ?at=", async () => {
    useListStore.setState({ tailOn: false, bufferedIds: ["a", "b", "c"] })
    render(
      <MemoryRouter initialEntries={["/requests?at=xyz"]}>
        <ShadcnLiveDock />
        <LocationProbe />
      </MemoryRouter>,
    )
    const cta = screen.getByRole("button", { name: /待合入/ })
    expect(cta.textContent).toMatch(/3 待合入/)
    await userEvent.click(cta)
    expect(useListStore.getState().tailOn).toBe(true)
    expect(useListStore.getState().bufferedIds).toEqual([])
    expect(screen.getByTestId("loc").textContent).not.toContain("at=")
  })

  it("tail 开关:live 时显 ▶ live,点击暂停(tailOn→false)", async () => {
    useListStore.setState({ tailOn: true, bufferedIds: [] })
    render(
      <MemoryRouter initialEntries={["/requests"]}>
        <ShadcnLiveDock />
      </MemoryRouter>,
    )
    const toggle = screen.getByRole("button", { name: /live/i })
    expect(toggle.getAttribute("aria-pressed")).toBe("true")
    await userEvent.click(toggle)
    expect(useListStore.getState().tailOn).toBe(false)
    expect(screen.getByRole("button", { name: /paused/i })).toBeTruthy()
  })

  it("非 /requests 路由:在途摘要全局显示,tail 开关 / 待合入 CTA 均隐藏(列表专属)", () => {
    seed([row("a"), row("b")])
    useListStore.setState({ tailOn: false, bufferedIds: ["x", "y"] })
    render(
      <MemoryRouter initialEntries={["/overview"]}>
        <ShadcnLiveDock />
      </MemoryRouter>,
    )
    expect(screen.getByText(/2 in-flight/)).toBeTruthy()
    expect(screen.queryByText(/待合入/)).toBeNull()
    expect(screen.queryByText(/▶ live|⏸ paused/)).toBeNull()
  })
})

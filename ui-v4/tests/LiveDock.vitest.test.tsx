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

import { LiveDock } from "@/components/requests/LiveDock"
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

/** 探针:把当前路由 path+search 暴露到 DOM,断言合入 CTA 是否清掉 ?at=。 */
function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>
}

describe("LiveDock", () => {
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
        <LiveDock />
      </MemoryRouter>,
    )
    expect(screen.getByText(/idle/i)).toBeTruthy()
  })

  it("有在途:折叠条显 in-flight 计数,点击展开出明细", async () => {
    seed([row("a"), row("b", { state: "pending", stream: false })])
    render(
      <MemoryRouter>
        <LiveDock />
      </MemoryRouter>,
    )
    expect(screen.getByText(/2 in-flight/)).toBeTruthy()
    // 折叠态无明细行
    expect(screen.queryByText(/anthropic/)).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: /in-flight/i }))
    // 展开后出现明细(endpoint 文本)
    expect(screen.getAllByText(/anthropic/).length).toBeGreaterThan(0)
  })

  it("展开态 Escape 收起", async () => {
    seed([row("a")])
    render(
      <MemoryRouter>
        <LiveDock />
      </MemoryRouter>,
    )
    await userEvent.click(screen.getByRole("button", { name: /in-flight/i }))
    expect(screen.getAllByText(/anthropic/).length).toBeGreaterThan(0)
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByText(/anthropic/)).toBeNull()
  })

  it("tail 暂停且有 buffered:状态栏显「待合入」CTA,点击 flush 合入并恢复 tail", async () => {
    useListStore.setState({ tailOn: false, bufferedIds: ["a", "b", "c"] })
    render(
      <MemoryRouter initialEntries={["/requests"]}>
        <LiveDock />
      </MemoryRouter>,
    )
    const cta = screen.getByRole("button", { name: /待合入/ })
    expect(cta.textContent).toMatch(/3 待合入/)
    await userEvent.click(cta)
    // flush:合入 buffered + 恢复 tail
    expect(useListStore.getState().tailOn).toBe(true)
    expect(useListStore.getState().bufferedIds).toEqual([])
    expect(screen.queryByText(/待合入/)).toBeNull()
  })

  it("tail-on 或无 buffered:不显「待合入」CTA", () => {
    // tail-on(默认)即使有 buffered 也不显(缓冲只在 paused 期填充,tail-on 时应为空)
    useListStore.setState({ tailOn: true, bufferedIds: [] })
    render(
      <MemoryRouter initialEntries={["/requests"]}>
        <LiveDock />
      </MemoryRouter>,
    )
    expect(screen.queryByText(/待合入/)).toBeNull()
  })

  it("合入时清掉 URL 的 ?at= 定位参数(tail 态不该声明 locate,与头部 resume 同源)", async () => {
    useListStore.setState({ tailOn: false, bufferedIds: ["a"] })
    render(
      <MemoryRouter initialEntries={["/requests?at=xyz"]}>
        <LiveDock />
        <LocationProbe />
      </MemoryRouter>,
    )
    expect(screen.getByTestId("loc").textContent).toContain("at=xyz")
    await userEvent.click(screen.getByRole("button", { name: /待合入/ }))
    expect(screen.getByTestId("loc").textContent).not.toContain("at=")
    expect(useListStore.getState().tailOn).toBe(true)
  })

  it("tail 开关:live 时显 ▶ live,点击暂停自动刷新(tailOn→false)", async () => {
    useListStore.setState({ tailOn: true, bufferedIds: [] })
    render(
      <MemoryRouter initialEntries={["/requests"]}>
        <LiveDock />
      </MemoryRouter>,
    )
    const toggle = screen.getByRole("button", { name: /live/i })
    expect(toggle.getAttribute("aria-pressed")).toBe("true")
    await userEvent.click(toggle)
    expect(useListStore.getState().tailOn).toBe(false)
    // 暂停后 CTA 文案变为 paused
    expect(screen.getByRole("button", { name: /paused/i })).toBeTruthy()
  })

  it("tail 开关:paused 时显 ⏸ paused,点击恢复(tailOn→true)并清掉 ?at=", async () => {
    useListStore.setState({ tailOn: false, bufferedIds: [] })
    render(
      <MemoryRouter initialEntries={["/requests?at=xyz"]}>
        <LiveDock />
        <LocationProbe />
      </MemoryRouter>,
    )
    const toggle = screen.getByRole("button", { name: /paused/i })
    expect(toggle.getAttribute("aria-pressed")).toBe("false")
    await userEvent.click(toggle)
    expect(useListStore.getState().tailOn).toBe(true)
    expect(screen.getByTestId("loc").textContent).not.toContain("at=")
  })

  it("非 /requests 路由(全局浮窗):显示在途信息,但 tail 开关 / 待合入 CTA 均隐藏(列表专属)", () => {
    seed([row("a"), row("b")])
    useListStore.setState({ tailOn: false, bufferedIds: ["x", "y"] }) // 有缓冲 + 暂停,但非列表页
    render(
      <MemoryRouter initialEntries={["/overview"]}>
        <LiveDock />
      </MemoryRouter>,
    )
    // 在途摘要全局显示
    expect(screen.getByText(/2 in-flight/)).toBeTruthy()
    // 列表专属控件隐藏
    expect(screen.queryByText(/待合入/)).toBeNull()
    expect(screen.queryByText(/▶ live|⏸ paused/)).toBeNull()
  })
})

import {
  //
  render,
  screen,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
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
      <MemoryRouter>
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
      <MemoryRouter>
        <LiveDock />
      </MemoryRouter>,
    )
    expect(screen.queryByText(/待合入/)).toBeNull()
  })
})

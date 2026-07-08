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
import { useLiveStore } from "@/stores/live-store"

const row = (id: string, over: Partial<LiveEntry> = {}): LiveEntry =>
  ({ id, endpoint: "anthropic-messages", state: "streaming", startTime: Date.now() - 3000, model: "claude", stream: true, ...over }) as LiveEntry

function seed(rows: Array<LiveEntry>) {
  useLiveStore.setState({ byId: Object.fromEntries(rows.map((r) => [r.id, r])) })
}

describe("LiveDock", () => {
  beforeEach(() => {
    useLiveStore.setState({ byId: {} })
    localStorage.clear()
  })
  afterEach(() => useLiveStore.setState({ byId: {} }))

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
})

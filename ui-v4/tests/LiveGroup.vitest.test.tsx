import {
  //
  render,
  screen,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  //
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { LiveEntry } from "@/stores/live-store"

import { LiveDetailRow } from "@/components/requests/LiveGroup"

const row = (over: Partial<LiveEntry>): LiveEntry =>
  ({ id: "r1", endpoint: "anthropic-messages", state: "streaming", startTime: 1000, model: "claude", ...over }) as LiveEntry

describe("LiveDetailRow", () => {
  it("渲染富字段:state/endpoint/elapsed/attempt/queueWait/retry", () => {
    render(
      <LiveDetailRow
        row={row({
          state: "streaming",
          resolvedModel: "claude-x",
          clientModel: "claude",
          attemptCount: 2,
          currentStrategy: "exhaustive",
          queueWaitMs: 120,
          stream: true,
          retry: { attempt: 2, willRetry: true, nextStrategy: "fallback", waitMs: 800 },
        })}
        nowMs={4000}
        onClick={() => {}}
      />,
    )
    expect(screen.getByText(/streaming/)).toBeTruthy()
    expect(screen.getByText(/3\.0s|3s/)).toBeTruthy() // elapsed 4000-1000
    expect(screen.getByText(/exhaustive/)).toBeTruthy()
    expect(screen.getByText(/next:/i)).toBeTruthy()
  })

  it("点击触发 onClick", async () => {
    const onClick = vi.fn()
    render(
      <LiveDetailRow
        row={row({})}
        nowMs={2000}
        onClick={onClick}
      />,
    )
    await userEvent.click(screen.getByRole("button"))
    expect(onClick).toHaveBeenCalledOnce()
  })
})

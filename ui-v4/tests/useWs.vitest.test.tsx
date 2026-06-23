import { render } from "@testing-library/react"
import {
  //
  describe,
  expect,
  it,
  vi,
} from "vitest"

let captured: { onStatusChange?: (c: boolean) => void } | null = null
vi.mock("@/lib/ws-client", () => ({
  wsClient: {
    acquire: (cb: { onStatusChange?: (c: boolean) => void }) => {
      captured = cb
      return () => {
        captured = null
      }
    },
  },
}))

// import AFTER the mock
const { useWs } = await import("@/hooks/useWs")

function Probe({ value, sink }: { value: number; sink: (v: number) => void }) {
  useWs({ onStatusChange: () => sink(value) })
  return null
}

describe("useWs latest-ref", () => {
  it("invokes the LATEST callbacks after a re-render (not the mount-time closure)", () => {
    const seen: Array<number> = []
    const { rerender } = render(
      <Probe
        value={1}
        sink={(v) => seen.push(v)}
      />,
    )
    rerender(
      <Probe
        value={2}
        sink={(v) => seen.push(v)}
      />,
    )
    captured?.onStatusChange?.(true)
    expect(seen).toEqual([2]) // latest value, NOT the stale 1
  })
})

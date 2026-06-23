import {
  //
  render,
  screen,
} from "@testing-library/react"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

import type { SseEventRecord } from "@/types"

import { SseFrameDiff } from "@/components/detail/diff/SseFrameDiff"

const frame = (type: string, raw: string, offsetMs = 0): SseEventRecord => ({ type, raw, offsetMs })

describe("SseFrameDiff", () => {
  it("renders modified / dropped / added rows + stat badge", () => {
    const upstream = [
      frame("message_start", `{"type":"message_start","v":1}`),
      frame("content_block_delta", `{"type":"content_block_delta","text":"upstream"}`),
      frame("ping", `{"type":"ping"}`),
    ]
    const forwarded = [
      frame("message_start", `{"type":"message_start","v":1}`),
      frame("content_block_delta", `{"type":"content_block_delta","text":"forwarded"}`),
      frame("synthetic", `{"type":"synthetic"}`),
    ]
    render(
      <SseFrameDiff
        upstream={upstream}
        forwarded={forwarded}
      />,
    )
    // modified row → inline word diff exposes both old + new payload text
    expect(screen.getByText(/upstream/)).toBeDefined()
    expect(screen.getByText(/forwarded/)).toBeDefined()
    // dropped (upstream-only) + added (forwarded-only) frame types render
    expect(screen.getByText(/^ping$/)).toBeDefined()
    expect(screen.getByText(/^synthetic$/)).toBeDefined()
    // stat badge: 1 modified ~, 1 removed −, 1 added +
    expect(screen.getByText(/1~ 1− 1\+/)).toBeDefined()
  })

  it("renders the oversized notice and no diff rows past MAX_INPUT", () => {
    const upstream = Array.from({ length: 2001 }, (_, i) => frame("delta", `{"i":${i}}`))
    const forwarded = Array.from({ length: 2001 }, (_, i) => frame("delta", `{"i":${i}}`))
    render(
      <SseFrameDiff
        upstream={upstream}
        forwarded={forwarded}
      />,
    )
    expect(screen.getByText(/Stream too large to diff inline \(2001 \+ 2001 frames\)\./)).toBeDefined()
    // stat badge must not render (no diff was computed)
    expect(screen.queryByText(/~ 0− 0\+/)).toBeNull()
  })

  it("renders nothing when both arrays are empty", () => {
    const { container } = render(
      <SseFrameDiff
        upstream={[]}
        forwarded={[]}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})

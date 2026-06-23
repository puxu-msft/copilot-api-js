import {
  //
  describe,
  expect,
  it,
} from "bun:test"

import {
  //
  isActiveRequestChanged,
  isConnected,
  isEntryAdded,
} from "@/types/ws"

describe("ws message guards", () => {
  it("discriminates by type", () => {
    expect(isActiveRequestChanged({ type: "active_request_changed", data: { action: "created", activeCount: 1 }, timestamp: 0 })).toBe(true)
    expect(isConnected({ type: "connected", data: { clientCount: 1, activeRequests: [] }, timestamp: 0 })).toBe(true)
    expect(isEntryAdded({ type: "entry_added", data: {}, timestamp: 0 })).toBe(true)
    expect(isActiveRequestChanged({ type: "entry_added", data: {}, timestamp: 0 })).toBe(false)
  })
})

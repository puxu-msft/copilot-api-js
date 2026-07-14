/**
 * setUpstreamTransportConfig / onUpstreamTransportChange — the split-out
 * upstream-transport-axis state setter (three-axis config reorg, plan-1 Task 5).
 * Mirrors the existing pattern for setTimeoutConfig / onRequestWatchdogChange
 * (renamed from onTransportTimeoutChange in this same Task, Step 4b).
 */
import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  onUpstreamTransportChange,
  setUpstreamTransportConfig,
  state,
} from "~/lib/state"

describe("setUpstreamTransportConfig / onUpstreamTransportChange", () => {
  let unsubscribe: (() => void) | undefined

  afterEach(() => {
    unsubscribe?.()
    unsubscribe = undefined
    // restore defaults so this file never leaks state into siblings
    setUpstreamTransportConfig({
      upstreamKeepaliveDelay: 15,
      upstreamH2PingInterval: 15,
      sessionConnectTimeout: 10,
      pooledConnectionIdleTimeout: 300,
      softMaxUpstreamWsConnections: 32,
    })
  })

  test("updates state fields", () => {
    setUpstreamTransportConfig({ sessionConnectTimeout: 20 })
    expect(state.sessionConnectTimeout).toBe(20)
  })

  test("upstreamH2PingInterval change notifies onUpstreamTransportChange listeners (fixes a pre-existing gap where setTimeoutConfig never notified on this field)", () => {
    let notified = 0
    unsubscribe = onUpstreamTransportChange(() => {
      notified += 1
    })
    setUpstreamTransportConfig({ upstreamH2PingInterval: 25 })
    expect(notified).toBe(1)
  })

  test("sessionConnectTimeout / pooledConnectionIdleTimeout / softMaxUpstreamWsConnections changes also notify", () => {
    let notified = 0
    unsubscribe = onUpstreamTransportChange(() => {
      notified += 1
    })
    setUpstreamTransportConfig({ sessionConnectTimeout: 5 })
    setUpstreamTransportConfig({ pooledConnectionIdleTimeout: 60 })
    setUpstreamTransportConfig({ softMaxUpstreamWsConnections: 8 })
    expect(notified).toBe(3)
  })

  test("setting the same value again does NOT notify (change-detection, mirrors setTimeoutConfig behavior)", () => {
    let notified = 0
    setUpstreamTransportConfig({ sessionConnectTimeout: 10 })
    unsubscribe = onUpstreamTransportChange(() => {
      notified += 1
    })
    setUpstreamTransportConfig({ sessionConnectTimeout: 10 })
    expect(notified).toBe(0)
  })

  test("unsubscribe stops further notifications", () => {
    let notified = 0
    unsubscribe = onUpstreamTransportChange(() => {
      notified += 1
    })
    unsubscribe()
    setUpstreamTransportConfig({ sessionConnectTimeout: 30 })
    expect(notified).toBe(0)
    unsubscribe = undefined
  })
})

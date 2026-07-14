import { describe, it, expect, beforeEach } from "bun:test"

import { recordReaperTick, getReaperDiagnostics, resetReaperDiagnosticsForTests } from "~/lib/observability/reaper-diagnostics"

describe("reaper-diagnostics", () => {
  beforeEach(() => {
    resetReaperDiagnosticsForTests()
  })

  it("computes driftMs = actualAt - scheduledAt", () => {
    recordReaperTick({ scheduledAt: 1000, actualAt: 1260, scanDurationMs: 2, activeCount: 3, liveMaxAgeSec: 1200, frozenIntervalMs: 60000, monotonicGapMs: 260, wallGapMs: 260 })
    const snap = getReaperDiagnostics()
    expect(snap.lastTick?.driftMs).toBe(260)
  })

  it("flags suspectSuspend when wall-clock gap far exceeds monotonic gap (process/WSL suspend, not event-loop block)", () => {
    // Timer fired 260ms late by wall clock, but the monotonic clock only advanced 60ms →
    // the process was suspended ~200ms (WSL2 suspend), NOT the event loop blocked.
    recordReaperTick({ scheduledAt: 1000, actualAt: 1260, scanDurationMs: 2, activeCount: 3, liveMaxAgeSec: 1200, frozenIntervalMs: 60000, monotonicGapMs: 60, wallGapMs: 260 })
    const snap = getReaperDiagnostics()
    expect(snap.lastTick?.suspectSuspend).toBe(true)
  })

  it("does NOT flag suspend when monotonic and wall gaps agree (event-loop block or normal jitter)", () => {
    recordReaperTick({ scheduledAt: 1000, actualAt: 1260, scanDurationMs: 2, activeCount: 3, liveMaxAgeSec: 1200, frozenIntervalMs: 60000, monotonicGapMs: 258, wallGapMs: 260 })
    const snap = getReaperDiagnostics()
    expect(snap.lastTick?.suspectSuspend).toBe(false)
  })

  it("retains a bounded ring buffer of recent ticks (newest last)", () => {
    for (let i = 0; i < 5; i++) {
      recordReaperTick({ scheduledAt: i * 1000, actualAt: i * 1000 + 10, scanDurationMs: 1, activeCount: i, liveMaxAgeSec: 1200, frozenIntervalMs: 60000, monotonicGapMs: 10, wallGapMs: 10 })
    }
    const snap = getReaperDiagnostics()
    expect(snap.recentTicks.length).toBe(5)
    expect(snap.recentTicks.at(-1)?.activeCount).toBe(4)
    expect(snap.lastTick?.activeCount).toBe(4)
  })
})

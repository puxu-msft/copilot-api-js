import { expect, test } from "bun:test"

import { stopTelemetryBackgroundWork } from "../../src/lib/request-telemetry"

test("stopTelemetryBackgroundWork 导出且可重复调用不抛（幂等）", () => {
  expect(() => {
    stopTelemetryBackgroundWork()
    stopTelemetryBackgroundWork()
  }).not.toThrow()
})

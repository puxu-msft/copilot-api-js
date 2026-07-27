import { stopTelemetryBackgroundWork } from "@hsupu/ghc-proxy-telemetry/testing"
import {
  //
  expect,
  test,
} from "bun:test"

test("stopTelemetryBackgroundWork 导出且可重复调用不抛（幂等）", () => {
  expect(() => {
    stopTelemetryBackgroundWork()
    stopTelemetryBackgroundWork()
  }).not.toThrow()
})

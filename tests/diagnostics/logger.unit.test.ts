import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { createDiagnosticLogger } from "~/lib/diagnostics/logger"
import { createBus } from "~/lib/observability"

describe("DiagnosticLogger", () => {
  test("child bindings are immutable, correlated, redacted, and published as canonical events", () => {
    const bus = createBus()
    const events: Array<unknown> = []
    bus.subscribe(
      (event) => {
        if (event.kind === "system.diagnostic") events.push(event.diagnostic)
      },
      undefined,
      { name: "capture" },
    )
    const bindings = { scope: ["transport"], correlation: { requestId: "req-1" }, fields: { authorization: "probe-secret" } }
    const logger = createDiagnosticLogger(bus.scope("system"), bindings)
    bindings.scope[0] = "mutated"
    bindings.correlation.requestId = "mutated"
    logger.info("connected", "Connected", { attempt: 2 })

    expect(events).toHaveLength(1)
    const serialized = JSON.stringify(events[0])
    expect(serialized).toContain('"scope":["transport"]')
    expect(serialized).toContain('"requestId":"req-1"')
    expect(serialized).toContain('"attempt":2')
    expect(serialized).not.toContain("probe-secret")
  })
})

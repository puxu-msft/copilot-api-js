import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  createDiagnosticEvent,
  snapshotDiagnosticValue,
} from "~/lib/diagnostics"

describe("diagnostic snapshot boundary", () => {
  test("special values are tagged without collisions or numeric loss", () => {
    const source = { marker: { $type: "bigint", value: "user-data" }, bigint: 9007199254740993n, nan: Number.NaN, negativeZero: -0 }
    const value = snapshotDiagnosticValue(source)
    expect(value).toEqual({
      $type: "object",
      value: {
        marker: { $type: "object", value: { $type: "bigint", value: "user-data" } },
        bigint: { $type: "bigint", value: "9007199254740993" },
        nan: { $type: "number", value: "NaN" },
        negativeZero: { $type: "number", value: "-0" },
      },
    })
  })

  test("cycles and throwing getters never escape", () => {
    const source: Record<string, unknown> = {}
    source.self = source
    Object.defineProperty(source, "secret", {
      enumerable: true,
      get: () => {
        throw new Error("getter boom")
      },
    })
    expect(() => snapshotDiagnosticValue(source)).not.toThrow()
    expect(JSON.stringify(snapshotDiagnosticValue(source))).toContain("circular")
    expect(JSON.stringify(snapshotDiagnosticValue(source))).toContain("unavailable")
  })

  test("events are redacted and deeply frozen before publication", () => {
    const source = { nested: { authorization: "Bearer gho_secret" } }
    const event = createDiagnosticEvent({ level: "info", event: "test", message: "token gho_secret", fields: source, origin: "native" })
    source.nested.authorization = "changed"
    expect(event.message).not.toContain("gho_secret")
    expect(JSON.stringify(event.fields)).not.toContain("gho_secret")
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.fields)).toBe(true)
  })
})

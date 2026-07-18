import { expect, test } from "bun:test"

import { PATHS } from "../../src/lib/config/paths"

test("PATHS.PIDFILE 在 APP_DIR 下、名为 copilot-api.pid", () => {
  expect(PATHS.PIDFILE.endsWith("copilot-api.pid")).toBe(true)
  expect(PATHS.PIDFILE.startsWith(PATHS.APP_DIR)).toBe(true)
})

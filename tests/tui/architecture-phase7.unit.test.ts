import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const tuiRoot = fileURLToPath(new URL("../../src/lib/tui/", import.meta.url))
const terminalUiPath = `${tuiRoot}terminal-ui.ts`
const DIRECT_STREAM_WRITE = /\b(?:stdout|stream)\.write\s*\(/
const STORE_ALGORITHM = /request\.feature_applied|request\.attempt_started|tool-call-recovered/

describe("TUI architecture guard", () => {
  test("positive controls prove the guards detect deliberate violations", () => {
    expect(DIRECT_STREAM_WRITE.test("stdout.write(frame)")).toBe(true)
    expect(STORE_ALGORITHM.test('case "request.feature_applied":')).toBe(true)
  })

  test("TerminalUi remains a thin orchestrator below 400 lines", () => {
    const source = readFileSync(terminalUiPath, "utf8")
    expect(source.split("\n").length).toBeLessThan(400)
    expect(source).not.toMatch(DIRECT_STREAM_WRITE)
    expect(source).not.toMatch(STORE_ALGORITHM)
  })

  test("direct terminal stream writes are confined to OutputArbiter", () => {
    for (const relative of ["terminal-ui.ts", "terminal-view.ts", "render/region.ts", "terminal-session.ts"]) {
      const source = readFileSync(`${tuiRoot}${relative}`, "utf8")
      expect(source).not.toMatch(DIRECT_STREAM_WRITE)
    }
    expect(readFileSync(`${tuiRoot}output-arbiter.ts`, "utf8")).toMatch(/\.write\s*\(/)
  })
})

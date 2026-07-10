import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  readdirSync,
  readFileSync,
} from "node:fs"
import { fileURLToPath } from "node:url"

function tuiFiles(): Array<string> {
  const root = fileURLToPath(new URL("../../src/lib/tui/", import.meta.url))
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => root + f)
}
// Match both the barrel form (`~/lib/observability/sinks`) and any sub-path
// (`~/lib/observability/sinks/file`). The trailing char class anchors on either
// a path separator or the closing quote so a future sinks/index.ts barrel
// import is still caught.
const SINK_IMPORT = /from\s+["']~\/lib\/observability\/sinks[/"']/
const RAW_STDIN = /setRawMode|process\.stdin/

describe("tui layer boundaries (L1 guard)", () => {
  test("guard reaches real files (positive control)", () => {
    expect(tuiFiles().length).toBeGreaterThan(0) // 空集合会让下面断言真空通过
    expect(RAW_STDIN.test("stdin.setRawMode(true)")).toBe(true) // 证正则真能命中
    expect(SINK_IMPORT.test('import x from "~/lib/observability/sinks/file"')).toBe(true)
    expect(SINK_IMPORT.test('import x from "~/lib/observability/sinks"')).toBe(true) // barrel form
  })
  test("no tui file imports another observability sink", () => {
    for (const f of tuiFiles()) expect(readFileSync(f, "utf8")).not.toMatch(SINK_IMPORT)
  })
  test("P0 tui has no stdin/raw-mode usage yet (that is P1)", () => {
    for (const f of tuiFiles()) expect(readFileSync(f, "utf8")).not.toMatch(RAW_STDIN)
  })
})

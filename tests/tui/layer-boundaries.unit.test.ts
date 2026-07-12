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

/**
 * Raw-mode / stdin ownership (P1): the terminal integration owner
 * (`terminal-ui.ts`) drives the raw-mode lifecycle. The pure leaves —
 * `controller.ts` (state machine), `render/*` (presentation builders + Region),
 * and `input/keys.ts` (a pure Buffer→KeyEvent parser that never reads a stream)
 * — must stay raw-mode-free so they remain unit-testable without a terminal.
 * (The `eslint.config.js` path-group formalization lands in the dedicated P1
 * boundary task.)
 */
const RAW_MODE_OWNER = "terminal-ui.ts"
const isPureLeaf = (f: string): boolean => !f.endsWith(RAW_MODE_OWNER)

/**
 * `terminal-coordinator.ts` (P2.1/P2.2, ADR `docs/decisions/2026-07-10-tui-terminal-ownership.md`)
 * is documented as a pure leaf: it imports nothing from `~/lib/tui/*` (render/,
 * input/, controller.ts, terminal-ui.ts — whether via the `~/lib/tui/...` alias
 * or a relative `./render`/`./terminal-ui`/`./input`/`./controller` path) or
 * `~/lib/observability/*`. Observability/terminal-ui import the coordinator,
 * never the reverse — this regex formalizes that one-directional edge so a
 * future PR wiring the coordinator back into `region`/`terminal-ui`/`sinks`/
 * observability internals (which would create the cycle the ADR forbids) fails
 * a test instead of only a code-review eyeball.
 */
const COORDINATOR_NAME = "terminal-coordinator.ts"
const TUI_INTERNAL_OR_OBSERVABILITY_IMPORT =
  /from\s+["'](?:\.\/(?:render|terminal-ui|input|controller)(?:\/[^"']*)?|~\/lib\/tui\/(?:render|terminal-ui|input|controller)(?:\/[^"']*)?|~\/lib\/observability(?:\/[^"']*)?)["']/

describe("tui layer boundaries (L1 guard)", () => {
  test("guard reaches real files (positive control)", () => {
    expect(tuiFiles().length).toBeGreaterThan(0) // 空集合会让下面断言真空通过
    expect(RAW_STDIN.test("stdin.setRawMode(true)")).toBe(true) // 证正则真能命中
    expect(SINK_IMPORT.test('import x from "~/lib/observability/sinks/file"')).toBe(true)
    expect(SINK_IMPORT.test('import x from "~/lib/observability/sinks"')).toBe(true) // barrel form
    // Positive control: the raw-mode owner really does use raw mode (else the
    // "pure leaves" assertion below could pass vacuously if the owner were renamed).
    const owner = tuiFiles().find((f) => f.endsWith(RAW_MODE_OWNER))
    expect(owner).toBeDefined()
    expect(readFileSync(owner!, "utf8")).toMatch(RAW_STDIN)
  })
  test("no tui file imports another observability sink", () => {
    for (const f of tuiFiles()) expect(readFileSync(f, "utf8")).not.toMatch(SINK_IMPORT)
  })
  test("raw-mode/stdin is confined to the integration owner — pure leaves stay terminal-free", () => {
    for (const f of tuiFiles().filter(isPureLeaf)) {
      expect(readFileSync(f, "utf8")).not.toMatch(RAW_STDIN)
    }
  })
  test("guard for coordinator purity reaches the real file + regex has discriminating power (positive control)", () => {
    const coordinator = tuiFiles().find((f) => f.endsWith(COORDINATOR_NAME))
    expect(coordinator).toBeDefined() // 文件不存在会让下面断言真空通过
    // Prove the regex actually fires on every forbidden import shape before
    // trusting its absence below — aliased tui-internal, relative tui-internal,
    // and aliased observability (bare + sub-path).
    expect(TUI_INTERNAL_OR_OBSERVABILITY_IMPORT.test('import { Region } from "~/lib/tui/render/region"')).toBe(true)
    expect(TUI_INTERNAL_OR_OBSERVABILITY_IMPORT.test('import { TerminalUi } from "./terminal-ui"')).toBe(true)
    expect(TUI_INTERNAL_OR_OBSERVABILITY_IMPORT.test('import { parseKeys } from "./input/keys"')).toBe(true)
    expect(TUI_INTERNAL_OR_OBSERVABILITY_IMPORT.test('import { reduce } from "./controller"')).toBe(true)
    expect(TUI_INTERNAL_OR_OBSERVABILITY_IMPORT.test('import type { ObservabilityBus } from "~/lib/observability"')).toBe(true)
    expect(TUI_INTERNAL_OR_OBSERVABILITY_IMPORT.test('import { publish } from "~/lib/observability/bus"')).toBe(true)
    // Negative control: an unrelated import must NOT trip the regex, or the
    // assertion below would be trivially satisfied by an over-eager pattern.
    expect(TUI_INTERNAL_OR_OBSERVABILITY_IMPORT.test('import consola from "consola"')).toBe(false)
  })
  test("terminal-coordinator stays a pure leaf — no tui-internal or observability imports", () => {
    const coordinator = tuiFiles().find((f) => f.endsWith(COORDINATOR_NAME))
    expect(coordinator).toBeDefined()
    expect(readFileSync(coordinator!, "utf8")).not.toMatch(TUI_INTERNAL_OR_OBSERVABILITY_IMPORT)
  })
})

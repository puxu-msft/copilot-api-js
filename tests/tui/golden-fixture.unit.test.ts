/**
 * P0 equivalence oracle — golden fixture capture.
 *
 * Captures the current `ConsoleSink` stdout byte stream for a fixed,
 * three-stream-interleaved scenario and asserts it matches the committed
 * golden (`__fixtures__/console-golden.txt`). The scenario deliberately
 * exercises every rendered line class so the golden is a non-empty positive
 * sample:
 *   - `[....]` start line   (onCreated, consola.level >= 5)
 *   - `[<-->]` footer        (printLog → renderFooter, active requests)
 *   - `[INFO]` system.log    (republished consola line)
 *   - `[ OK ]` completion    (onTerminal completed leg)
 *   - `[FAIL]` failure       (onTerminal error leg)
 *
 * The P0 terminal-layer reorg is a behavior-equivalent pure restructure, so
 * every later task re-runs this scenario and asserts byte-for-byte equivalence
 * against the frozen golden.
 *
 * NOT covered here (intentionally): the 100ms footer redraw timer. Under a
 * frozen clock with synchronous publishing the `setInterval` never fires, and
 * feeding it a synthetic tick would make the fixture flaky. Footer *content*
 * is still covered via `printLog → renderFooter`. The retained
 * `console-footer` / `console-system-log` / `console-thinking` /
 * `pipeline-retry-tui` regression suites remain the primary equivalence oracle;
 * this golden is a supplementary whole-stream snapshot.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test"
import consola from "consola"
import { readFileSync } from "node:fs"

import type { RequestContextSnapshot } from "~/lib/observability"

import { createDiagnosticEvent } from "~/lib/diagnostics"
import { createBus } from "~/lib/observability"
import { attachTerminalUi } from "~/lib/tui"

const NOW = 1_700_000_000_000
const SGR_PATTERN = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, "g")

function makeCapture() {
  const chunks: Array<string> = []
  const stdout = { write: (s: string) => (chunks.push(s), true), isTTY: true } as unknown as NodeJS.WritableStream
  // picocolors support is process-global and may differ between an isolated
  // run and the full suite. SGR styling is covered by renderer unit tests; this
  // whole-stream oracle normalizes only SGR while preserving cursor controls.
  return {
    stdout,
    text: () =>
      chunks
        .join("")
        .replaceAll(SGR_PATTERN, "")
        .replaceAll(/\d\d:\d\d:\d\d/g, "TT:TT:TT"),
  }
}

export function renderGoldenScenario(attach: (bus: ReturnType<typeof createBus>, o: unknown) => () => void): string {
  const cap = makeCapture()
  const bus = createBus()
  const prevLevel = consola.level
  consola.level = 5 // render the [....] start line (console.ts onCreated guard)
  const detach = attach(bus, { stdout: cap.stdout, isTTY: true, columns: 80, refreshIntervalMs: 0, progressIntervalMs: 0, now: () => NOW })
  const req = bus.scope("request")
  const sys = bus.scope("system")
  const ctxA = {
    id: "a",
    endpoint: "anthropic-messages",
    method: "POST",
    path: "/v1/messages",
    resolvedModel: "claude-opus-4-8",
    state: "streaming",
    startTime: NOW - 3000,
    queueWaitMs: 0,
  } satisfies RequestContextSnapshot
  const ctxB: RequestContextSnapshot = { ...ctxA, id: "b", resolvedModel: "gpt-5", startTime: NOW - 1000 }
  const ctxC: RequestContextSnapshot = { ...ctxA, id: "c", resolvedModel: "gpt-5", startTime: NOW - 500 }
  req.publish({ kind: "request.created", ctx: ctxA })
  req.publish({ kind: "request.created", ctx: ctxB })
  req.publish({ kind: "request.created", ctx: ctxC })
  req.publish({ kind: "request.stream_progress", ctx: ctxA, bytesIn: 12_345, eventsIn: 42 } as never)
  sys.publish({
    kind: "system.diagnostic",
    diagnostic: createDiagnosticEvent({ level: "info", event: "test.golden", message: "golden line", timeUnixMs: NOW, origin: "native" }),
  })
  req.publish({ kind: "request.completed", ctx: ctxA, entry: { id: "a", endpoint: "anthropic-messages", state: "completed" } } as never)
  req.publish({ kind: "request.failed", ctx: ctxB, statusCode: 429, error: "rate_limited" } as never) // error 腿
  detach()
  consola.level = prevLevel
  return cap.text()
}

beforeEach(() => setSystemTime(new Date(NOW)))
afterEach(() => setSystemTime())

describe("golden fixture (P0 equivalence oracle)", () => {
  test("current renderer output matches the committed golden", () => {
    const out = renderGoldenScenario(attachTerminalUi as never)
    const golden = readFileSync(new URL("./__fixtures__/console-golden.txt", import.meta.url), "utf8")
    expect(out).toBe(golden)
  })
})

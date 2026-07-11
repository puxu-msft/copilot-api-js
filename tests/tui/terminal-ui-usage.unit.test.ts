/**
 * TerminalUi usage threading — proves the completion line surfaces token +
 * cache-rate columns sourced from the terminal event's `entry` (via
 * `resolveResponseUsage`).
 *
 * This is the wiring oracle for the fix that terminal events carry
 * `entry: HistoryEntryData` but `onTerminal` previously discarded it, so the
 * pre-existing `formatTokens` / cache-rate columns never lit up. We drive the
 * real bus → TerminalUi path and assert the captured `[ OK ]` stdout line.
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

import type { RequestContextSnapshot } from "~/lib/observability"

import { createBus } from "~/lib/observability"
import { attachTerminalUi } from "~/lib/tui"

const NOW = 1_700_000_000_000
// eslint-disable-next-line no-control-regex -- intentional ANSI escape range
const stripAnsi = (s: string): string => s.replaceAll(/\x1b\[[0-9;]*m/g, "")

function makeCapture() {
  const chunks: Array<string> = []
  const stdout = { write: (s: string) => (chunks.push(s), true), isTTY: true } as unknown as NodeJS.WritableStream
  return { stdout, text: () => stripAnsi(chunks.join("")) }
}

/** A completed entry whose final attempt's upstream response carries usage. */
function entryWithUsage(usage: Record<string, number>) {
  return {
    id: "a",
    endpoint: "anthropic-messages",
    state: "completed",
    attempts: [{ index: 0, durationMs: 0, upstreamResponse: { success: true, usage } }],
  }
}

beforeEach(() => setSystemTime(new Date(NOW)))
afterEach(() => setSystemTime())

describe("TerminalUi — completion line usage threading", () => {
  function drive(entry: unknown): string {
    const cap = makeCapture()
    const bus = createBus()
    const prevLevel = consola.level
    consola.level = 5
    const detach = attachTerminalUi(bus, { stdout: cap.stdout, isTTY: true, columns: 200 })
    const ctx = {
      id: "a",
      endpoint: "anthropic-messages",
      method: "POST",
      path: "/v1/messages",
      resolvedModel: "claude-opus-4-8",
      state: "streaming",
      startTime: NOW - 1200,
      queueWaitMs: 0,
    } satisfies RequestContextSnapshot
    const req = bus.scope("request")
    req.publish({ kind: "request.created", ctx })
    req.publish({ kind: "request.completed", ctx, entry } as never)
    detach()
    consola.level = prevLevel
    return cap.text()
  }

  test("token column + cache-rate marker render from the entry's upstream usage", () => {
    const out = drive(
      entryWithUsage({
        input_tokens: 1000,
        output_tokens: 456,
        cache_read_input_tokens: 8000,
        cache_creation_input_tokens: 1000,
      }),
    )
    const okLine = out.split("\n").find((l) => l.includes("[ OK ]"))
    expect(okLine).toBeDefined()
    expect(okLine).toContain("↑1.0k+8.0k+1.0k ↻80%+10% ↓456")
  })

  test("entry without usage (no attempts) renders no token column — golden path unchanged", () => {
    const out = drive({ id: "a", endpoint: "anthropic-messages", state: "completed" })
    const okLine = out.split("\n").find((l) => l.includes("[ OK ]"))
    expect(okLine).toBeDefined()
    expect(okLine).not.toContain("↻")
    expect(okLine).not.toContain("↑1.0k")
  })
})

/**
 * TerminalUi wiring oracle for the completion line's `tool_use(<names>)` token — proves the
 * real `bus → onTerminal → stdout` path resolves tool names, including the recovered-tool
 * FALLBACK. The upstream-original response body keeps the raw downgraded TEXT with no tool_use
 * block (Option A), so a recovered turn's name is ONLY on the `tool-call-recovered` feature
 * detail; without the fallback the line degrades to a bare `tool_use`.
 *
 * Guards the wiring a formatter-only test cannot: the feature-detail stash
 * (`entry.recoveredToolNames`), the upstream-body-empty fallback, and the primary
 * upstream-body extraction still winning when it has names.
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

beforeEach(() => setSystemTime(new Date(NOW)))
afterEach(() => setSystemTime())

describe("TerminalUi — completion-line tool_use(<names>) token", () => {
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

  /** Drive created → (optional feature) → completed and return the [ OK ] line. */
  function drive(entry: unknown, opts?: { recoveredTools?: Array<string> }): string | undefined {
    const cap = makeCapture()
    const bus = createBus()
    const prevLevel = consola.level
    consola.level = 5
    const detach = attachTerminalUi(bus, { stdout: cap.stdout, isTTY: true, columns: 200 })
    const req = bus.scope("request")
    req.publish({ kind: "request.created", ctx })
    if (opts?.recoveredTools) {
      req.publish({ kind: "request.feature_applied", ctx, feature: "tool-call-recovered", detail: { tools: opts.recoveredTools } })
    }
    req.publish({ kind: "request.completed", ctx, entry } as never)
    detach()
    consola.level = prevLevel
    return cap
      .text()
      .split("\n")
      .find((l) => l.includes("[ OK ]"))
  }

  const recoveredEntry = {
    id: "a",
    endpoint: "anthropic-messages",
    state: "completed",
    attempts: [
      {
        index: 0,
        durationMs: 0,
        // Upstream-original track (Option A): the raw downgraded TEXT, stop_reason=tool_use,
        // NO tool_use block — exactly what makes the bare-`tool_use` bug appear.
        upstreamResponse: {
          success: true,
          stopReason: "tool_use",
          body: { role: "assistant", content: [{ type: "text", text: '<function_calls><invoke name="search">…' }] },
        },
      },
    ],
  }

  test("recovered tool_use with no upstream block → falls back to feature-detail names", () => {
    const ok = drive(recoveredEntry, { recoveredTools: ["search"] })
    expect(ok).toContain("tool_use(search)")
  })

  test("without the recovered-name feature the same body degrades to a bare tool_use", () => {
    // Guards that the fixture is genuinely name-less (the fallback is what supplies the name).
    const ok = drive(recoveredEntry)
    expect(ok).toContain("tool_use")
    expect(ok).not.toContain("tool_use(")
  })

  test("upstream body WITH tool_use blocks wins over the recovered fallback", () => {
    const ok = drive(
      {
        id: "a",
        endpoint: "anthropic-messages",
        state: "completed",
        attempts: [
          {
            index: 0,
            durationMs: 0,
            upstreamResponse: {
              success: true,
              stopReason: "tool_use",
              body: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
            },
          },
        ],
      },
      { recoveredTools: ["search"] },
    )
    expect(ok).toContain("tool_use(Bash)")
    expect(ok).not.toContain("search")
  })
})

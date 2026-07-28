/**
 * TerminalUi wiring oracle for the response-side thinking token — proves the
 * real `bus → onTerminal → stdout` path lights up `think:…` from a completed
 * entry's final-attempt `upstreamResponse.body`, NOT just that `formatLogLine`
 * accepts a hand-built `responseThinking` (that seam is the FORCE_COLOR test).
 *
 * Guards the wiring that a formatter-only test cannot: the body read
 * (`responseThinkingFromBody(finalUpstreamResponse?.body)`), the final-attempt
 * selection, and the `isError` suppression (error lines carry no token).
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

describe("TerminalUi — response-thinking token threading", () => {
  function drive(entry: unknown, kind: "request.completed" | "request.failed" = "request.completed"): string {
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
    req.publish({ kind, ctx, entry } as never)
    detach()
    consola.level = prevLevel
    return cap.text()
  }

  const line = (out: string, tag: string): string | undefined => out.split("\n").find((l) => l.includes(tag))

  test("real GHC encrypted thinking (empty plaintext + signature) → [ OK ] line shows think:enc(1)", () => {
    const out = drive({
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
            body: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "", signature: "ErIECokBCA8YAipA" },
                { type: "tool_use", id: "t1", name: "Bash", input: {} },
              ],
            },
          },
        },
      ],
    })
    expect(line(out, "[ OK ]")).toContain("think:enc(1)")
  })

  test("final attempt wins — an earlier attempt's body is not read", () => {
    const out = drive({
      id: "a",
      endpoint: "anthropic-messages",
      state: "completed",
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: { success: false, body: { role: "assistant", content: [{ type: "thinking", thinking: "old plaintext" }] } },
        },
        {
          index: 1,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            stopReason: "end_turn",
            body: { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }] },
          },
        },
      ],
    })
    const ok = line(out, "[ OK ]")
    expect(ok).toContain("think:enc(1)") // from the final attempt
    expect(ok).not.toContain("think:13") // not the earlier "old plaintext" (13 chars)
  })

  test("error terminal renders NO thinking token even when the body carries thinking", () => {
    const out = drive(
      {
        id: "a",
        endpoint: "anthropic-messages",
        state: "failed",
        attempts: [
          {
            index: 0,
            durationMs: 0,
            error: "boom",
            upstreamResponse: { success: false, body: { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }] } },
          },
        ],
      },
      "request.failed",
    )
    const fail = line(out, "[FAIL]")
    expect(fail).toBeDefined()
    expect(fail).not.toContain("think:")
  })

  test("contentless refusal failure shows a named refusal category even though failure lines suppress stop_reason", () => {
    const out = drive(
      {
        id: "a",
        endpoint: "anthropic-messages",
        state: "failed",
        attempts: [
          {
            index: 0,
            durationMs: 0,
            error: "upstream contentless refusal",
            upstreamResponse: {
              success: true,
              stopReason: "refusal",
              stopDetails: { type: "refusal", category: "cyber", explanation: "diagnostic only" },
              body: { role: "assistant", content: [] },
            },
          },
        ],
      },
      "request.failed",
    )
    const fail = line(out, "[FAIL]")
    expect(fail).toContain("refusal:cyber")
    expect(fail).not.toContain("diagnostic only")
  })

  test("refusal with an explicit null category shows refusal:uncategorized", () => {
    const out = drive(
      {
        id: "a",
        endpoint: "anthropic-messages",
        state: "failed",
        attempts: [
          {
            index: 0,
            durationMs: 0,
            error: "upstream contentless refusal",
            upstreamResponse: {
              success: true,
              stopReason: "refusal",
              stopDetails: { type: "refusal", category: null, explanation: "diagnostic only" },
              body: { role: "assistant", content: [] },
            },
          },
        ],
      },
      "request.failed",
    )
    expect(line(out, "[FAIL]")).toContain("refusal:uncategorized")
  })

  test("no thinking blocks → no think: token on the [ OK ] line", () => {
    const out = drive({
      id: "a",
      endpoint: "anthropic-messages",
      state: "completed",
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: { success: true, stopReason: "end_turn", body: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
        },
      ],
    })
    const ok = line(out, "[ OK ]")
    expect(ok).toBeDefined()
    expect(ok).not.toContain("think:")
  })
})

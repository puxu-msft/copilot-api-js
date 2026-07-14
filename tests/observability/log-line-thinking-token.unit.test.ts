/**
 * `formatThinkingToken` — render the response-side thinking dimension as a
 * compact completion-line token, sitting next to the stop_reason token.
 *
 * Three visual states (text asserted here; the gray/yellow COLOR routing is
 * pinned in the FORCE_COLOR integration test, since bun collapses colors to
 * identity under `pc.isColorSupported === false`):
 *   plaintext present  → `think:<chars>(<blocks>)`   gray
 *   encrypted / redacted (empty plaintext, not poisoned) → `think:enc(<blocks>)` gray
 *   poisoned (empty plaintext, no signature) → `think:poison(<blocks>)` yellow
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ResponseThinking } from "~/lib/history/entry-view"

import { formatThinkingToken } from "~/lib/observability/projections/log-line"

// eslint-disable-next-line no-control-regex -- intentional ANSI escape range
const stripAnsi = (s: string): string => s.replaceAll(/\x1b\[[0-9;]*m/g, "")

const rt = (over: Partial<ResponseThinking>): ResponseThinking => ({ blockCount: 1, chars: 0, hasSignature: false, poisoned: false, ...over })

describe("formatThinkingToken", () => {
  test("plaintext present → think:<abbrev chars>(<blocks>)", () => {
    expect(stripAnsi(formatThinkingToken(rt({ blockCount: 3, chars: 1200 })))).toBe("think:1.2k(3)")
    expect(stripAnsi(formatThinkingToken(rt({ blockCount: 1, chars: 42 })))).toBe("think:42(1)")
  })

  test("encrypted (empty plaintext + signature) → think:enc(<blocks>)", () => {
    expect(stripAnsi(formatThinkingToken(rt({ blockCount: 3, chars: 0, hasSignature: true })))).toBe("think:enc(3)")
  })

  test("redacted-only (empty plaintext, no signature, not poisoned) → think:enc(<blocks>)", () => {
    expect(stripAnsi(formatThinkingToken(rt({ blockCount: 1, chars: 0, hasSignature: false, poisoned: false })))).toBe("think:enc(1)")
  })

  test("poisoned → think:poison(<blocks>)", () => {
    expect(stripAnsi(formatThinkingToken(rt({ blockCount: 2, chars: 0, poisoned: true })))).toBe("think:poison(2)")
  })

  test("poisoned takes precedence even if chars somehow > 0 (defensive)", () => {
    // poisoned is derived to be mutually exclusive with chars>0, but the renderer
    // must not silently show a friendly count for a poison verdict.
    expect(stripAnsi(formatThinkingToken(rt({ blockCount: 1, chars: 5, poisoned: true })))).toBe("think:poison(1)")
  })
})

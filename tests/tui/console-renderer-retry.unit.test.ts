/**
 * Unit tests for `ConsoleRenderer.onRequestRetry` — verifies that the
 * `[RETRY-n]` line correctly carries status/method/path/model/duration and
 * the dim `(retryable: ...)` metadata, and that the footer three-step
 * (`clearFooterForLog → write → renderFooter`) is preserved so a retry line
 * doesn't trample an in-flight footer.
 *
 * We treat `process.stdout.isTTY` as `false` (the default in bun test) so
 * the footer doesn't actually render — but the `printLog` path still routes
 * through `clearFooterForLog()`/`renderFooter()`, both of which become
 * no-ops when `isTTY === false`. The substantive assertion is on the
 * **line content** written for the retry event.
 */

import {
  //
  afterEach,
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  TuiLogEntry,
  TuiRenderer,
} from "~/lib/tui"

import { tuiLogger } from "~/lib/tui"
import { ConsoleRenderer } from "~/lib/tui/console-renderer"

interface CapturedWrite {
  chunk: string
}

function installStdoutCapture(): { captured: Array<CapturedWrite>; restore: () => void } {
  const captured: Array<CapturedWrite> = []
  const original = process.stdout.write.bind(process.stdout)
  // Bun's typing for stdout.write is the standard 3-overload union; assigning
  // a simpler capture function requires a small `as` cast.
  process.stdout.write = ((chunk: unknown) => {
    if (typeof chunk === "string") captured.push({ chunk })
    else if (chunk instanceof Uint8Array) captured.push({ chunk: Buffer.from(chunk).toString("utf8") })
    return true
  }) as typeof process.stdout.write
  return {
    captured,
    restore: () => {
      process.stdout.write = original
    },
  }
}

function makeEntry(overrides: Partial<TuiLogEntry> = {}): TuiLogEntry {
  return {
    id: "test-id",
    method: "POST",
    path: "/v1/messages",
    model: "claude-opus-4.8",
    startTime: Date.now() - 1200,
    status: "executing",
    requestBodySize: 15_000,
    ...overrides,
  }
}

let priorRenderer: TuiRenderer | null = null

afterEach(() => {
  tuiLogger.clear()
  // Restore the renderer that was installed before each test ran.
  tuiLogger.setRenderer(priorRenderer)
  priorRenderer = null
})

describe("ConsoleRenderer.onRequestRetry", () => {
  test("writes a [RETRY-1] line with status, model, error, and (retryable: ...) metadata", () => {
    const capture = installStdoutCapture()
    try {
      const renderer = new ConsoleRenderer({ showActive: false })
      const entry = makeEntry()
      renderer.onRequestRetry(entry, {
        attempt: 1,
        strategyName: "network-retry",
        statusCode: 502,
        error: "ECONNRESET",
        waitMs: 1000,
      })
      renderer.destroy()

      const out = capture.captured.map((c) => c.chunk).join("")
      // Strip ANSI for substring matching — picocolors may or may not emit them.
      // eslint-disable-next-line no-control-regex
      const plain = out.replaceAll(/\[[\d;]*m/g, "")

      expect(plain).toContain("[RETRY-1]")
      expect(plain).toContain("502")
      expect(plain).toContain("POST")
      expect(plain).toContain("/v1/messages")
      expect(plain).toContain("claude-opus-4.8")
      expect(plain).toContain(": ECONNRESET")
      expect(plain).toContain("(retryable: network-retry, wait 1.0s)")
    } finally {
      capture.restore()
    }
  })

  test("omits waitMs when 0/undefined; includes 'learning' suffix when set", () => {
    const capture = installStdoutCapture()
    try {
      const renderer = new ConsoleRenderer({ showActive: false })
      renderer.onRequestRetry(makeEntry(), {
        attempt: 2,
        strategyName: "unsupported-beta-retry",
        statusCode: 400,
        error: "invalid beta flag",
        learning: true,
      })
      renderer.destroy()

      const plain = capture.captured
        .map((c) => c.chunk)
        .join("")
        // eslint-disable-next-line no-control-regex
        .replaceAll(/\[[\d;]*m/g, "")
      expect(plain).toContain("[RETRY-2]")
      expect(plain).toContain("(retryable: unsupported-beta-retry, learning)")
      // No wait segment when waitMs is unset.
      expect(plain).not.toContain("wait ")
    } finally {
      capture.restore()
    }
  })

  test("logRetry flows through the tracker → renderer hook", () => {
    const capture = installStdoutCapture()
    try {
      priorRenderer = (tuiLogger as unknown as { renderer: TuiRenderer | null }).renderer
      const renderer = new ConsoleRenderer({ showActive: false })
      tuiLogger.setRenderer(renderer)

      const id = tuiLogger.startRequest({ method: "POST", path: "/v1/messages", model: "claude-opus-4.8" })
      // Drain any output from startRequest.
      capture.captured.length = 0

      tuiLogger.logRetry(id, {
        attempt: 1,
        strategyName: "auto-truncate",
        statusCode: 413,
        error: "Payload too large",
      })

      const plain = capture.captured
        .map((c) => c.chunk)
        .join("")
        // eslint-disable-next-line no-control-regex
        .replaceAll(/\[[\d;]*m/g, "")
      expect(plain).toContain("[RETRY-1]")
      expect(plain).toContain("413")
      expect(plain).toContain(": Payload too large")
      expect(plain).toContain("(retryable: auto-truncate)")

      renderer.destroy()
    } finally {
      capture.restore()
    }
  })

  test("logRetry on unknown id is a no-op (no write)", () => {
    const capture = installStdoutCapture()
    try {
      priorRenderer = (tuiLogger as unknown as { renderer: TuiRenderer | null }).renderer
      const renderer = new ConsoleRenderer({ showActive: false })
      tuiLogger.setRenderer(renderer)

      tuiLogger.logRetry("nonexistent-id", {
        attempt: 1,
        strategyName: "x",
        statusCode: 500,
        error: "y",
      })

      const plain = capture.captured.map((c) => c.chunk).join("")
      expect(plain).not.toContain("[RETRY-")

      renderer.destroy()
    } finally {
      capture.restore()
    }
  })
})

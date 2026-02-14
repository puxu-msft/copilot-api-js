/**
 * Unit tests for shutdown state management and pure functions.
 */

import { afterEach, describe, expect, test } from "bun:test"

import type { TuiLogEntry } from "~/lib/tui/types"

import {
  _resetShutdownState,
  formatActiveRequestsSummary,
  getIsShuttingDown,
  getShutdownSignal,
  gracefulShutdown,
} from "~/lib/shutdown"

import { createMockServer } from "../helpers/mock-server"
import { createMockTracker } from "../helpers/mock-tracker"

afterEach(() => {
  _resetShutdownState()
})

// ─── State management ───

describe("getIsShuttingDown", () => {
  test("returns false initially", () => {
    expect(getIsShuttingDown()).toBe(false)
  })

  test("returns true after shutdown begins", async () => {
    const tracker = createMockTracker()
    const server = createMockServer()

    // Start shutdown (will complete immediately since no active requests)
    await gracefulShutdown("SIGINT", {
      tracker,
      server,
      rateLimiter: null,
      stopTokenRefreshFn: () => {},
      closeAllClientsFn: () => {},
      getClientCountFn: () => 0,
    })

    expect(getIsShuttingDown()).toBe(true)
  })
})

describe("getShutdownSignal", () => {
  test("returns undefined before shutdown", () => {
    expect(getShutdownSignal()).toBeUndefined()
  })

  test("returns AbortSignal after shutdown begins", async () => {
    const tracker = createMockTracker()
    const server = createMockServer()

    await gracefulShutdown("SIGINT", {
      tracker,
      server,
      rateLimiter: null,
      stopTokenRefreshFn: () => {},
      closeAllClientsFn: () => {},
      getClientCountFn: () => 0,
    })

    const signal = getShutdownSignal()
    expect(signal).toBeDefined()
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  test("signal is not aborted when no active requests (skips Phase 3)", async () => {
    const tracker = createMockTracker() // empty = no active requests
    const server = createMockServer()

    await gracefulShutdown("SIGINT", {
      tracker,
      server,
      rateLimiter: null,
      stopTokenRefreshFn: () => {},
      closeAllClientsFn: () => {},
      getClientCountFn: () => 0,
    })

    // No active requests → Phase 2/3 skipped → signal never aborted
    expect(getShutdownSignal()!.aborted).toBe(false)
  })
})

// ─── formatActiveRequestsSummary ───

describe("formatActiveRequestsSummary", () => {
  test("formats single request with model, status, and age", () => {
    const requests = [
      {
        id: "req-1",
        method: "POST",
        path: "/v1/messages",
        status: "streaming" as const,
        startTime: Date.now() - 5000,
        model: "claude-sonnet-4",
        tags: [],
      },
    ] as Array<TuiLogEntry>

    const result = formatActiveRequestsSummary(requests)
    expect(result).toContain("Waiting for 1 active request(s)")
    expect(result).toContain("POST /v1/messages claude-sonnet-4")
    expect(result).toContain("streaming")
  })

  test("formats multiple requests with tags", () => {
    const requests = [
      {
        id: "req-1",
        method: "POST",
        path: "/v1/messages",
        status: "streaming" as const,
        startTime: Date.now() - 10000,
        model: "claude-sonnet-4",
        tags: ["thinking:adaptive"],
      },
      {
        id: "req-2",
        method: "POST",
        path: "/v1/chat/completions",
        status: "executing" as const,
        startTime: Date.now() - 2000,
        model: "gpt-4o",
        tags: [],
      },
    ] as Array<TuiLogEntry>

    const result = formatActiveRequestsSummary(requests)
    expect(result).toContain("Waiting for 2 active request(s)")
    expect(result).toContain("[thinking:adaptive]")
    expect(result).toContain("gpt-4o")
  })

  test("handles requests without model", () => {
    const requests = [
      {
        id: "req-1",
        method: "POST",
        path: "/v1/messages",
        status: "executing" as const,
        startTime: Date.now(),
        model: undefined,
        tags: [],
      },
    ] as Array<TuiLogEntry>

    const result = formatActiveRequestsSummary(requests)
    expect(result).toContain("unknown")
  })
})

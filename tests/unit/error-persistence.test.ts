/**
 * Tests for error persistence consumer (handleErrorPersistence).
 * Verifies that "failed" events produce correct error file structures.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { RequestContextEvent } from "~/lib/context/manager"
import type { HistoryEntryData } from "~/lib/context/request"

import { handleErrorPersistence } from "~/lib/context/error-persistence"

import { waitUntil } from "../helpers/wait-until"

// ============================================================================
// Helpers
// ============================================================================

let tmpDir: string
let originalErrorDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "error-persist-test-"))
  const pathsMod = await import("~/lib/config/paths")
  originalErrorDir = pathsMod.PATHS.ERROR_DIR
  ;(pathsMod.PATHS as { ERROR_DIR: string }).ERROR_DIR = path.join(tmpDir, "errmsgs")
})

afterEach(async () => {
  const pathsMod = await import("~/lib/config/paths")
  ;(pathsMod.PATHS as { ERROR_DIR: string }).ERROR_DIR = originalErrorDir
  await fs.rm(tmpDir, { recursive: true, force: true })
})

/** Create a mock "failed" event with HistoryEntryData */
function mockFailedEvent(overrides?: Partial<HistoryEntryData>): RequestContextEvent {
  const ts = Date.now()
  const entry: HistoryEntryData = {
    id: "test-ctx-id",
    endpoint: "anthropic-messages",
    startedAt: ts,
    endedAt: ts + 150,
    state: "failed",
    active: false,
    lastUpdatedAt: ts + 150,
    queueWaitMs: 0,
    attemptCount: 1,
    durationMs: 150,
    request: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    },
    response: {
      success: false,
      model: "claude-sonnet-4",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: null,
      error: "HTTP 400: token limit exceeded",
      status: 400,
      responseText: '{"error":{"type":"invalid_request_error","message":"prompt is too long"}}',
    },
    attempts: [{ index: 0, durationMs: 100, error: "HTTP 400: token limit" }],
    ...overrides,
  }

  return {
    type: "failed",
    context: { toHistoryEntry: () => entry } as any,
    entry,
  }
}

async function readErrorDirEntries(): Promise<Array<string>> {
  const errmsgsDir = path.join(tmpDir, "errmsgs")
  try {
    return await fs.readdir(errmsgsDir)
  } catch {
    return []
  }
}

async function waitForErrorDirEntries(count = 1): Promise<Array<string>> {
  const errmsgsDir = path.join(tmpDir, "errmsgs")
  await waitUntil(
    async () => existsSync(errmsgsDir) && (await fs.readdir(errmsgsDir)).length >= count,
    { label: `error directory to contain at least ${count} entr${count === 1 ? "y" : "ies"}` },
  )
  return await readErrorDirEntries()
}

/** Wait for async write to complete and return error directory entries */
async function getErrorDirEntries(): Promise<Array<string>> {
  return waitForErrorDirEntries()
}

/** Read all files from the first error subdirectory */
async function readErrorFiles(): Promise<{ files: Array<string>; dir: string }> {
  const entries = await getErrorDirEntries()
  expect(entries.length).toBeGreaterThan(0)
  const dir = path.join(tmpDir, "errmsgs", entries[0])
  const files = (await fs.readdir(dir)).sort()
  return { files, dir }
}

// ============================================================================
// handleErrorPersistence
// ============================================================================

describe("handleErrorPersistence", () => {
  test("writes meta.json with structured error info on failed event", async () => {
    handleErrorPersistence(mockFailedEvent())
    const { files, dir } = await readErrorFiles()

    expect(files).toContain("meta.json")

    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"))
    expect(meta.id).toBe("test-ctx-id")
    expect(meta.endpoint).toBe("anthropic-messages")
    expect(meta.durationMs).toBe(150)
    expect(meta.request.model).toBe("claude-sonnet-4")
    expect(meta.request.stream).toBe(true)
    expect(meta.request.messageCount).toBe(1)
    expect(meta.response.success).toBe(false)
    expect(meta.response.error).toContain("token limit")
    expect(meta.response.status).toBe(400)
    expect(meta.attempts).toHaveLength(1)
  })

  test("writes request.json with full payload", async () => {
    handleErrorPersistence(mockFailedEvent())
    const { files, dir } = await readErrorFiles()

    expect(files).toContain("request.json")

    const request = JSON.parse(await fs.readFile(path.join(dir, "request.json"), "utf8"))
    expect(request.model).toBe("claude-sonnet-4")
    expect(request.stream).toBe(true)
    // Messages included (small payload, under 50 limit)
    expect(request.messages).toHaveLength(1)
  })

  test("writes response.txt with raw upstream response", async () => {
    handleErrorPersistence(mockFailedEvent())
    const { files, dir } = await readErrorFiles()

    expect(files).toContain("response.txt")

    const responseText = await fs.readFile(path.join(dir, "response.txt"), "utf8")
    expect(responseText).toContain("prompt is too long")
  })

  test("skips response.txt when responseText is not available", async () => {
    const event = mockFailedEvent({
      response: {
        success: false,
        model: "m",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: null,
        error: "connection reset",
      },
    })
    handleErrorPersistence(event)
    const { files } = await readErrorFiles()

    expect(files).not.toContain("response.txt")
  })

  test("writes sse-events.json when sseEvents exist", async () => {
    const event = mockFailedEvent({
      sseEvents: [
        { offsetMs: 10, type: "message_start", data: { id: "msg_1" } },
        { offsetMs: 50, type: "content_block_delta", data: { delta: { text: "hello" } } },
      ],
    })
    handleErrorPersistence(event)
    const { files, dir } = await readErrorFiles()

    expect(files).toContain("sse-events.json")

    const events = JSON.parse(await fs.readFile(path.join(dir, "sse-events.json"), "utf8"))
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe("message_start")
  })

  test("skips sse-events.json when sseEvents is empty", async () => {
    const event = mockFailedEvent({ sseEvents: [] })
    handleErrorPersistence(event)
    const { files } = await readErrorFiles()

    expect(files).not.toContain("sse-events.json")
  })

  test("ignores non-failed events", async () => {
    const completedEvent: RequestContextEvent = {
      type: "completed",
      context: {} as any,
      entry: {} as any,
    }
    handleErrorPersistence(completedEvent)

    const entries = await readErrorDirEntries()
    expect(entries).toHaveLength(0)
  })

  test("directory name follows YYMMDD_HHmmss_hex format", async () => {
    handleErrorPersistence(mockFailedEvent())
    const entries = await getErrorDirEntries()

    // Format: YYMMDD_HHmmss_8hexchars
    expect(entries[0]).toMatch(/^\d{6}_\d{6}_[0-9a-f]{8}$/)
  })

  test("multiple failures create separate subdirectories", async () => {
    handleErrorPersistence(mockFailedEvent({ id: "ctx-1" }))
    handleErrorPersistence(mockFailedEvent({ id: "ctx-2" }))

    const entries = await waitForErrorDirEntries(2)
    expect(entries).toHaveLength(2)

    // Each should have its own meta.json with different IDs
    const metas = await Promise.all(
      entries.map(async (e) => JSON.parse(await fs.readFile(path.join(tmpDir, "errmsgs", e, "meta.json"), "utf8"))),
    )
    const ids = new Set(metas.map((m) => m.id))
    expect(ids).toEqual(new Set(["ctx-1", "ctx-2"]))
  })

  test("omits messages for large payloads (over 50 messages)", async () => {
    const manyMessages = Array.from({ length: 60 }, (_, i) => ({
      role: "user" as const,
      content: `message ${i}`,
    }))
    const event = mockFailedEvent({
      request: {
        model: "m",
        messages: manyMessages as any,
        stream: false,
      },
    })
    handleErrorPersistence(event)
    const { dir } = await readErrorFiles()

    const request = JSON.parse(await fs.readFile(path.join(dir, "request.json"), "utf8"))
    // Messages should be omitted, but messageCount preserved
    expect(request.messages).toBeUndefined()
    expect(request.messageCount).toBe(60)
  })

  test("does not create errmsgs directory when no errors occur", async () => {
    const errmsgsDir = path.join(tmpDir, "errmsgs")
    const exists = await fs
      .access(errmsgsDir)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  test("writes effective-request.json when effectiveRequest is present", async () => {
    const event = mockFailedEvent({
      effectiveRequest: {
        model: "claude-sonnet-4-20250514",
        format: "anthropic-messages",
        messageCount: 2,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
        payload: {
          model: "claude-sonnet-4-20250514",
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
          ],
        },
      },
    })
    handleErrorPersistence(event)
    const { files, dir } = await readErrorFiles()

    expect(files).toContain("effective-request.json")

    const effective = JSON.parse(await fs.readFile(path.join(dir, "effective-request.json"), "utf8"))
    expect(effective.model).toBe("claude-sonnet-4-20250514")
    expect(effective.messages).toHaveLength(2)
    expect(effective.context_management).toBeUndefined()
  })

  test("writes wire-request.json when wireRequest is present", async () => {
    const event = mockFailedEvent({
      wireRequest: {
        model: "claude-sonnet-4-20250514",
        format: "anthropic-messages",
        messageCount: 2,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
        headers: {
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "context-management-2025-06-27",
        },
        payload: {
          model: "claude-sonnet-4-20250514",
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
          ],
          context_management: {
            edits: [{ type: "clear_tool_uses_20250919" }],
          },
        },
      },
    })
    handleErrorPersistence(event)
    const { files, dir } = await readErrorFiles()

    expect(files).toContain("wire-request.json")

    const wire = JSON.parse(await fs.readFile(path.join(dir, "wire-request.json"), "utf8"))
    expect(wire.headers).toEqual({
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "context-management-2025-06-27",
    })
    expect(wire.payload.context_management).toEqual({
      edits: [{ type: "clear_tool_uses_20250919" }],
    })
  })

  test("omits effective-request.json when effectiveRequest is not set", async () => {
    handleErrorPersistence(mockFailedEvent())
    const { files } = await readErrorFiles()

    expect(files).not.toContain("effective-request.json")
  })

  test("meta.json includes effective field when effectiveRequest is present", async () => {
    const event = mockFailedEvent({
      effectiveRequest: {
        model: "claude-sonnet-4-20250514",
        messageCount: 5,
      },
    })
    handleErrorPersistence(event)
    const { dir } = await readErrorFiles()

    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"))
    expect(meta.effective).toBeDefined()
    expect(meta.effective.model).toBe("claude-sonnet-4-20250514")
    expect(meta.effective.messageCount).toBe(5)
  })

  test("meta.json omits effective field when effectiveRequest is not set", async () => {
    handleErrorPersistence(mockFailedEvent())
    const { dir } = await readErrorFiles()

    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"))
    expect(meta.effective).toBeUndefined()
  })
})

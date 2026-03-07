import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"

import type { RequestContextEvent, RequestContextManager } from "~/lib/context/manager"

import { registerContextConsumers } from "~/lib/context/consumers"
import * as historyStore from "~/lib/history/store"
import * as tui from "~/lib/tui"

// ============================================================================
// Spy on real modules instead of mock.module (avoids cross-file pollution)
// ============================================================================

let insertEntrySpy: ReturnType<typeof spyOn>
let updateEntrySpy: ReturnType<typeof spyOn>
let getCurrentSessionSpy: ReturnType<typeof spyOn>
let isHistoryEnabledSpy: ReturnType<typeof spyOn>
let tuiUpdateSpy: ReturnType<typeof spyOn>
let tuiFinishSpy: ReturnType<typeof spyOn>

beforeAll(() => {
  insertEntrySpy = spyOn(historyStore, "insertEntry").mockImplementation(() => {})
  updateEntrySpy = spyOn(historyStore, "updateEntry").mockImplementation(() => {})
  getCurrentSessionSpy = spyOn(historyStore, "getCurrentSession").mockReturnValue("session_1")
  isHistoryEnabledSpy = spyOn(historyStore, "isHistoryEnabled").mockReturnValue(true)
  tuiUpdateSpy = spyOn(tui.tuiLogger, "updateRequest").mockImplementation(() => {})
  tuiFinishSpy = spyOn(tui.tuiLogger, "finishRequest").mockImplementation(() => {})
})

afterAll(() => {
  insertEntrySpy.mockRestore()
  updateEntrySpy.mockRestore()
  getCurrentSessionSpy.mockRestore()
  isHistoryEnabledSpy.mockRestore()
  tuiUpdateSpy.mockRestore()
  tuiFinishSpy.mockRestore()
})

// ============================================================================
// Fake EventEmitter-style manager
// ============================================================================

type ChangeHandler = (event: RequestContextEvent) => void

function createFakeManager(): RequestContextManager & { emit: (event: RequestContextEvent) => void } {
  const listeners: Array<ChangeHandler> = []
  return {
    on(_eventName: string, handler: ChangeHandler) {
      listeners.push(handler)
    },
    emit(event: RequestContextEvent) {
      for (const listener of listeners) {
        listener(event)
      }
    },
  } as unknown as RequestContextManager & { emit: (event: RequestContextEvent) => void }
}

// ============================================================================
// Tests
// ============================================================================

describe("registerContextConsumers", () => {
  let manager: ReturnType<typeof createFakeManager>

  beforeEach(() => {
    insertEntrySpy.mockClear()
    updateEntrySpy.mockClear()
    getCurrentSessionSpy.mockClear()
    getCurrentSessionSpy.mockReturnValue("session_1")
    isHistoryEnabledSpy.mockReturnValue(true)
    tuiUpdateSpy.mockClear()
    tuiFinishSpy.mockClear()

    manager = createFakeManager()
    registerContextConsumers(manager)
  })

  // ── History: created event ──

  describe("history consumer: created", () => {
    test("inserts history entry on 'created' event", () => {
      manager.emit({
        type: "created",
        context: {
          id: "req_1",
          endpoint: "anthropic-messages",
          startTime: Date.now(),
          state: "created",
          originalRequest: { model: "claude-sonnet-4", messages: [], stream: true },
        },
      } as unknown as RequestContextEvent)

      expect(insertEntrySpy).toHaveBeenCalledTimes(1)
      const entry = insertEntrySpy.mock.calls[0][0]
      expect(entry.id).toBe("req_1")
      expect(entry.sessionId).toBe("session_1")
      expect(entry.endpoint).toBe("anthropic-messages")
    })

    test("does not insert entry when history is disabled", () => {
      isHistoryEnabledSpy.mockReturnValue(false)

      manager.emit({
        type: "created",
        context: {
          id: "req_1",
          endpoint: "anthropic-messages",
          startTime: Date.now(),
          state: "created",
          originalRequest: { model: "claude-sonnet-4" },
        },
      } as unknown as RequestContextEvent)

      expect(insertEntrySpy).not.toHaveBeenCalled()
    })
  })

  // ── History: updated event ──

  describe("history consumer: updated", () => {
    test("updates request data on originalRequest field update", () => {
      manager.emit({
        type: "updated",
        field: "originalRequest",
        context: {
          id: "req_1",
          originalRequest: {
            model: "claude-sonnet-4",
            messages: [{ role: "user", content: "hi" }],
            stream: false,
          },
        },
      } as unknown as RequestContextEvent)

      expect(updateEntrySpy).toHaveBeenCalledTimes(1)
      const [id, data] = updateEntrySpy.mock.calls[0]
      expect(id).toBe("req_1")
      expect(data.request.model).toBe("claude-sonnet-4")
    })

    test("updates rewrites on rewrites field update", () => {
      const rewrites = { systemPrompt: "modified" }
      manager.emit({
        type: "updated",
        field: "rewrites",
        context: { id: "req_1", rewrites },
      } as unknown as RequestContextEvent)

      expect(updateEntrySpy).toHaveBeenCalledTimes(1)
      const [id, data] = updateEntrySpy.mock.calls[0]
      expect(id).toBe("req_1")
      expect(data.rewrites).toBe(rewrites)
    })

    test("ignores unrelated field updates", () => {
      manager.emit({
        type: "updated",
        field: "state",
        context: { id: "req_1" },
      } as unknown as RequestContextEvent)

      expect(updateEntrySpy).not.toHaveBeenCalled()
    })
  })

  // ── History: completed/failed events ──

  describe("history consumer: completed/failed", () => {
    test("updates entry with response data on completed", () => {
      manager.emit({
        type: "completed",
        context: { id: "req_1", tuiLogId: undefined },
        entry: {
          id: "req_1",
          durationMs: 1500,
          response: {
            success: true,
            model: "claude-sonnet-4",
            usage: { input_tokens: 100, output_tokens: 50 },
            stop_reason: "end_turn",
            content: { role: "assistant", content: "Hello" },
          },
        },
      } as unknown as RequestContextEvent)

      expect(updateEntrySpy).toHaveBeenCalledTimes(1)
      const [id, data] = updateEntrySpy.mock.calls[0]
      expect(id).toBe("req_1")
      expect(data.response.success).toBe(true)
      expect(data.response.model).toBe("claude-sonnet-4")
      expect(data.durationMs).toBe(1500)
    })

    test("updates entry on failed event", () => {
      manager.emit({
        type: "failed",
        context: { id: "req_1", tuiLogId: undefined },
        entry: {
          id: "req_1",
          durationMs: 500,
          response: {
            success: false,
            model: "claude-sonnet-4",
            usage: { input_tokens: 0, output_tokens: 0 },
            error: "Token expired",
          },
        },
      } as unknown as RequestContextEvent)

      expect(updateEntrySpy).toHaveBeenCalledTimes(1)
      const [id, data] = updateEntrySpy.mock.calls[0]
      expect(id).toBe("req_1")
      expect(data.response.success).toBe(false)
    })
  })

  // ── TUI consumer ──

  describe("tui consumer", () => {
    test("updates TUI on state_changed to streaming", () => {
      manager.emit({
        type: "state_changed",
        context: { tuiLogId: "tui_1", state: "streaming" },
      } as unknown as RequestContextEvent)

      expect(tuiUpdateSpy).toHaveBeenCalledWith("tui_1", { status: "streaming" })
    })

    test("updates TUI on state_changed to executing", () => {
      manager.emit({
        type: "state_changed",
        context: { tuiLogId: "tui_1", state: "executing" },
      } as unknown as RequestContextEvent)

      expect(tuiUpdateSpy).toHaveBeenCalledWith("tui_1", { status: "executing" })
    })

    test("ignores state_changed without tuiLogId", () => {
      manager.emit({
        type: "state_changed",
        context: { state: "streaming" },
      } as unknown as RequestContextEvent)

      expect(tuiUpdateSpy).not.toHaveBeenCalled()
    })

    test("finishes TUI request on completed with usage data", () => {
      manager.emit({
        type: "completed",
        context: {
          tuiLogId: "tui_1",
          response: {
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
          },
        },
        entry: {
          id: "req_1",
          durationMs: 1000,
          response: { success: true, model: "claude-sonnet-4", usage: { input_tokens: 100, output_tokens: 50 } },
        },
      } as unknown as RequestContextEvent)

      expect(tuiUpdateSpy).toHaveBeenCalledWith(
        "tui_1",
        expect.objectContaining({
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 10,
        }),
      )
      expect(tuiFinishSpy).toHaveBeenCalledWith("tui_1", { statusCode: 200 })
    })

    test("finishes TUI request on failed with error", () => {
      manager.emit({
        type: "failed",
        context: {
          tuiLogId: "tui_1",
          response: { error: "Rate limited" },
          currentAttempt: { error: { status: 429 } },
        },
        entry: {
          id: "req_1",
          durationMs: 200,
          response: {
            success: false,
            model: "gpt-4o",
            usage: { input_tokens: 0, output_tokens: 0 },
            error: "Rate limited",
          },
        },
      } as unknown as RequestContextEvent)

      expect(tuiFinishSpy).toHaveBeenCalledWith("tui_1", {
        error: "Rate limited",
        statusCode: 429,
      })
    })

    test("adds retry tags on attempts update", () => {
      manager.emit({
        type: "updated",
        field: "attempts",
        context: {
          tuiLogId: "tui_1",
          attempts: [{}, { strategy: "token-refresh" }],
          currentAttempt: { strategy: "token-refresh" },
        },
      } as unknown as RequestContextEvent)

      expect(tuiUpdateSpy).toHaveBeenCalledWith("tui_1", { tags: ["token-refresh"] })
    })
  })
})

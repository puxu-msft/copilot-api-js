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
    test("does NOT insert on 'created' event (deferred to originalRequest update)", () => {
      manager.emit({
        type: "created",
        context: {
          id: "req_1",
          endpoint: "anthropic-messages",
          startTime: Date.now(),
          state: "created",
          originalRequest: null,
        },
      } as unknown as RequestContextEvent)

      expect(insertEntrySpy).not.toHaveBeenCalled()
    })

    test("does not insert entry when history is disabled", () => {
      isHistoryEnabledSpy.mockReturnValue(false)

      manager.emit({
        type: "updated",
        field: "originalRequest",
        context: {
          id: "req_1",
          endpoint: "anthropic-messages",
          startTime: Date.now(),
          state: "pending",
          originalRequest: { model: "claude-sonnet-4", messages: [], stream: true },
        },
      } as unknown as RequestContextEvent)

      expect(insertEntrySpy).not.toHaveBeenCalled()
    })
  })

  // ── History: updated event ──

  describe("history consumer: updated", () => {
    test("inserts entry on originalRequest field update (deferred insert)", () => {
      manager.emit({
        type: "updated",
        field: "originalRequest",
        context: {
          id: "req_1",
          endpoint: "anthropic-messages",
          startTime: Date.now(),
          originalRequest: {
            model: "claude-sonnet-4",
            messages: [{ role: "user", content: "hi" }],
            stream: false,
          },
        },
      } as unknown as RequestContextEvent)

      expect(insertEntrySpy).toHaveBeenCalledTimes(1)
      const entry = insertEntrySpy.mock.calls[0][0]
      expect(entry.id).toBe("req_1")
      expect(entry.request.model).toBe("claude-sonnet-4")
    })

    test("updates pipelineInfo on pipelineInfo field update", () => {
      const rewrites = { systemPrompt: "modified" }
      manager.emit({
        type: "updated",
        field: "pipelineInfo",
        context: { id: "req_1", pipelineInfo: rewrites },
      } as unknown as RequestContextEvent)

      expect(updateEntrySpy).toHaveBeenCalledTimes(1)
      const [id, data] = updateEntrySpy.mock.calls[0]
      expect(id).toBe("req_1")
      expect(data.pipelineInfo).toBe(rewrites)
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

    test("preserves output_tokens_details through toHistoryResponse", () => {
      manager.emit({
        type: "completed",
        context: { id: "req_2", tuiLogId: undefined },
        entry: {
          id: "req_2",
          durationMs: 2000,
          response: {
            success: true,
            model: "claude-sonnet-4",
            usage: {
              input_tokens: 200,
              output_tokens: 100,
              cache_read_input_tokens: 50,
              output_tokens_details: { reasoning_tokens: 30 },
            },
            stop_reason: "end_turn",
            content: { role: "assistant", content: "Thinking..." },
          },
        },
      } as unknown as RequestContextEvent)

      expect(updateEntrySpy).toHaveBeenCalledTimes(1)
      const [, data] = updateEntrySpy.mock.calls[0]
      expect(data.response.usage.output_tokens_details).toEqual({ reasoning_tokens: 30 })
      expect(data.response.usage.cache_read_input_tokens).toBe(50)
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

    test("propagates effectiveRequest and wireRequest separately on completed", () => {
      manager.emit({
        type: "completed",
        context: { id: "req_1", tuiLogId: undefined },
        entry: {
          id: "req_1",
          durationMs: 1000,
          response: {
            success: true,
            model: "claude-sonnet-4",
            usage: { input_tokens: 50, output_tokens: 25 },
            content: null,
          },
          effectiveRequest: {
            model: "claude-sonnet-4-20250514",
            format: "anthropic-messages",
            messageCount: 3,
            messages: [{ role: "user", content: "hi" }],
            payload: {
              model: "claude-sonnet-4-20250514",
              messages: [{ role: "user", content: "hi" }],
              max_tokens: 4096,
            },
          },
          wireRequest: {
            model: "claude-sonnet-4-20250514",
            format: "anthropic-messages",
            messageCount: 3,
            messages: [{ role: "user", content: "hi" }],
            payload: {
              model: "claude-sonnet-4-20250514",
              messages: [{ role: "user", content: "hi" }],
              max_tokens: 4096,
              stream: true,
            },
            headers: { "x-request-id": "wire-abc" },
          },
          httpHeaders: {
            request: { "x-request-id": "abc" },
            response: { "content-type": "application/json" },
          },
        },
      } as unknown as RequestContextEvent)

      expect(updateEntrySpy).toHaveBeenCalledTimes(1)
      const [, data] = updateEntrySpy.mock.calls[0]
      expect(data.effectiveRequest).toBeDefined()
      expect(data.effectiveRequest.model).toBe("claude-sonnet-4-20250514")
      expect(data.effectiveRequest.payload).toEqual({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 4096,
      })
      expect(data.wireRequest).toEqual({
        model: "claude-sonnet-4-20250514",
        format: "anthropic-messages",
        messageCount: 3,
        messages: [{ role: "user", content: "hi" }],
        payload: {
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 4096,
          stream: true,
        },
        headers: { "x-request-id": "wire-abc" },
      })
    })

    test("propagates attempts array on completed", () => {
      manager.emit({
        type: "completed",
        context: { id: "req_1", tuiLogId: undefined },
        entry: {
          id: "req_1",
          durationMs: 1000,
          response: {
            success: true,
            model: "m",
            usage: { input_tokens: 50, output_tokens: 25 },
            content: null,
          },
          attempts: [
            { index: 0, durationMs: 500, effectiveMessageCount: 10 },
            { index: 1, strategy: "auto-truncate", durationMs: 500, effectiveMessageCount: 5 },
          ],
        },
      } as unknown as RequestContextEvent)

      const [, data] = updateEntrySpy.mock.calls[0]
      expect(data.attempts).toHaveLength(2)
      expect(data.attempts[1].strategy).toBe("auto-truncate")
    })

    test("propagates response.status, rawBody, and headers on failed", () => {
      manager.emit({
        type: "failed",
        context: { id: "req_1", tuiLogId: undefined },
        entry: {
          id: "req_1",
          durationMs: 200,
          response: {
            success: false,
            model: "m",
            usage: { input_tokens: 0, output_tokens: 0 },
            error: "Bad request",
            status: 400,
            responseText: '{"error":{"message":"thinking blocks cannot be modified"}}',
          },
          httpHeaders: {
            request: { authorization: "***" },
            response: { "x-request-id": "xyz" },
          },
        },
      } as unknown as RequestContextEvent)

      const [, data] = updateEntrySpy.mock.calls[0]
      expect(data.response.status).toBe(400)
      expect(data.response.rawBody).toBe('{"error":{"message":"thinking blocks cannot be modified"}}')
      expect(data.response.headers).toEqual({ "x-request-id": "xyz" })
    })

    test("omits effectiveRequest when entry has none", () => {
      manager.emit({
        type: "completed",
        context: { id: "req_1", tuiLogId: undefined },
        entry: {
          id: "req_1",
          durationMs: 100,
          response: {
            success: true,
            model: "m",
            usage: { input_tokens: 10, output_tokens: 5 },
            content: null,
          },
        },
      } as unknown as RequestContextEvent)

      const [, data] = updateEntrySpy.mock.calls[0]
      expect(data.effectiveRequest).toBeUndefined()
      expect(data.wireRequest).toBeUndefined()
      expect(data.attempts).toBeUndefined()
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

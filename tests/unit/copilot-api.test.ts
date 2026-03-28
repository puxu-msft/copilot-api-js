import { describe, expect, test } from "bun:test"

import type { State } from "~/lib/state"

import { copilotHeaders } from "~/lib/copilot-api"

/**
 * Unit tests for `~/lib/copilot-api` request header generation.
 */

// ============================================================================
// Helpers
// ============================================================================

function makeState(overrides: Partial<State> = {}): State {
  return {
    copilotToken: "test-token",
    vsCodeVersion: "1.104.3",
    accountType: "individual",
    ...overrides,
  } as State
}

// ============================================================================
// Tests
// ============================================================================

describe("copilotHeaders", () => {
  // ── Core headers ──

  test("returns required core headers", () => {
    const headers = copilotHeaders(makeState())

    expect(headers.Authorization).toBe("Bearer test-token")
    expect(headers["content-type"]).toBe("application/json")
    expect(headers["copilot-integration-id"]).toBe("vscode-chat")
    expect(headers["editor-version"]).toBe("vscode/1.104.3")
    expect(headers["x-github-api-version"]).toBe("2025-05-01")
    expect(headers["x-request-id"]).toBeDefined()
    expect(headers["X-Interaction-Id"]).toBeDefined()
  })

  test("generates unique x-request-id per call", () => {
    const s = makeState()
    const h1 = copilotHeaders(s)
    const h2 = copilotHeaders(s)
    expect(h1["x-request-id"]).not.toBe(h2["x-request-id"])
  })

  test("keeps same X-Interaction-Id across calls", () => {
    const s = makeState()
    const h1 = copilotHeaders(s)
    const h2 = copilotHeaders(s)
    expect(h1["X-Interaction-Id"]).toBe(h2["X-Interaction-Id"])
  })

  // ── Default opts behavior ──

  test("defaults openai-intent to conversation-panel when no opts", () => {
    const headers = copilotHeaders(makeState())
    expect(headers["openai-intent"]).toBe("conversation-panel")
  })

  test("does not set copilot-vision-request when no opts", () => {
    const headers = copilotHeaders(makeState())
    expect(headers["copilot-vision-request"]).toBeUndefined()
  })

  // ── Vision ──

  test("sets copilot-vision-request when vision is true", () => {
    const headers = copilotHeaders(makeState(), { vision: true })
    expect(headers["copilot-vision-request"]).toBe("true")
  })

  test("does not set copilot-vision-request when vision is false", () => {
    const headers = copilotHeaders(makeState(), { vision: false })
    expect(headers["copilot-vision-request"]).toBeUndefined()
  })

  // ── Intent ──

  test("sets custom openai-intent", () => {
    const headers = copilotHeaders(makeState(), { intent: "conversation-agent" })
    expect(headers["openai-intent"]).toBe("conversation-agent")
  })

  test("falls back to conversation-panel when intent is undefined", () => {
    const headers = copilotHeaders(makeState(), { intent: undefined })
    expect(headers["openai-intent"]).toBe("conversation-panel")
  })

  // ── Model request headers ──

  test("forwards model-specific request headers", () => {
    const headers = copilotHeaders(makeState(), {
      modelRequestHeaders: {
        "x-custom-model-header": "custom-value",
        "another-header": "another-value",
      },
    })
    expect(headers["x-custom-model-header"]).toBe("custom-value")
    expect(headers["another-header"]).toBe("another-value")
  })

  test("does not override core headers with model request headers", () => {
    const headers = copilotHeaders(makeState(), {
      modelRequestHeaders: {
        // Attempt to override Authorization — should be ignored
        Authorization: "Bearer malicious-token",
        "content-type": "text/plain",
        "openai-intent": "overridden",
      },
    })
    expect(headers.Authorization).toBe("Bearer test-token")
    expect(headers["content-type"]).toBe("application/json")
    expect(headers["openai-intent"]).toBe("conversation-panel")
  })

  test("does not override core headers with case-variant keys", () => {
    const headers = copilotHeaders(makeState(), {
      modelRequestHeaders: {
        authorization: "Bearer sneaky",
        "Content-Type": "text/xml",
        "OPENAI-INTENT": "overridden",
        "x-interaction-id": "fake-id",
      },
    })
    expect(headers.Authorization).toBe("Bearer test-token")
    expect(headers["content-type"]).toBe("application/json")
    expect(headers["openai-intent"]).toBe("conversation-panel")
    // Case-variant keys should not be added as separate entries
    expect(headers.authorization).toBeUndefined()
    expect(headers["Content-Type"]).toBeUndefined()
    expect(headers["OPENAI-INTENT"]).toBeUndefined()
  })

  // ── Combined opts ──

  test("supports all opts simultaneously", () => {
    const headers = copilotHeaders(makeState(), {
      vision: true,
      intent: "conversation-agent",
      modelRequestHeaders: { "x-model-header": "value" },
    })
    expect(headers["copilot-vision-request"]).toBe("true")
    expect(headers["openai-intent"]).toBe("conversation-agent")
    expect(headers["x-model-header"]).toBe("value")
  })
})

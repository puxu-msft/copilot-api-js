import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { State } from "~/lib/state"

import {
  cacheVSCodeVersion,
  copilotBaseUrl,
  copilotHeaders,
  getVSCodeVersion,
  githubHeaders,
  standardHeaders,
} from "~/lib/copilot-api"
import { restoreStateForTests, setStateForTests, snapshotStateForTests, state } from "~/lib/state"

/**
 * Unit tests for `~/lib/copilot-api` request header generation.
 */

// ============================================================================
// Helpers
// ============================================================================

function makeState(overrides: Partial<State> = {}): State {
  return {
    githubToken: "gh-test-token",
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
  const originalFetch = globalThis.fetch
  const originalState = snapshotStateForTests()

  beforeEach(() => {
    setStateForTests({
      githubToken: "gh-test-token",
      copilotToken: "test-token",
      vsCodeVersion: "1.104.3",
      accountType: "individual",
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreStateForTests(originalState)
  })

  test("returns the standard JSON headers", () => {
    expect(standardHeaders()).toEqual({
      "content-type": "application/json",
      accept: "application/json",
    })
  })

  test("builds the correct Copilot base URL for each account type", () => {
    expect(copilotBaseUrl(makeState({ accountType: "individual" }))).toBe("https://api.githubcopilot.com")
    expect(copilotBaseUrl(makeState({ accountType: "business" }))).toBe("https://api.business.githubcopilot.com")
    expect(copilotBaseUrl(makeState({ accountType: "enterprise" }))).toBe("https://api.enterprise.githubcopilot.com")
  })

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

  test("builds GitHub headers from shared state", () => {
    const headers = githubHeaders(state)

    expect(headers).toMatchObject({
      accept: "application/json",
      "content-type": "application/json",
      authorization: "token gh-test-token",
      "editor-version": "vscode/1.104.3",
      "editor-plugin-version": "copilot-chat/0.38.0",
      "user-agent": "GitHubCopilotChat/0.38.0",
      "x-github-api-version": "2022-11-28",
      "x-vscode-user-agent-library-version": "electron-fetch",
    })
  })

  test("getVSCodeVersion returns the latest release tag when GitHub succeeds", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ tag_name: "1.107.1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

    await expect(getVSCodeVersion()).resolves.toBe("1.107.1")
  })

  test("getVSCodeVersion falls back when GitHub returns a non-ok response", async () => {
    globalThis.fetch = mock(async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch

    await expect(getVSCodeVersion()).resolves.toBe("1.104.3")
  })

  test("getVSCodeVersion falls back when GitHub returns an invalid tag", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ tag_name: "stable" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

    await expect(getVSCodeVersion()).resolves.toBe("1.104.3")
  })

  test("getVSCodeVersion falls back when fetch throws", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch

    await expect(getVSCodeVersion()).resolves.toBe("1.104.3")
  })

  test("cacheVSCodeVersion stores the fetched version in global state", async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ tag_name: "1.106.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch

    await cacheVSCodeVersion()

    expect(state.vsCodeVersion).toBe("1.106.0")
  })
})

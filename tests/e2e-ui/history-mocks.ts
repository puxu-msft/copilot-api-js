import type { Page, Route } from "@playwright/test"

const BASE_TIMESTAMP = Date.UTC(2026, 3, 1, 9, 30, 0)

export interface MockSocketMessage {
  topic?: "history" | "requests" | "status"
  delayMs?: number
  message: {
    type: string
    data: unknown
    timestamp: number
  }
}

export interface HistoryUiScenario {
  summaryResult: {
    entries: Array<Record<string, unknown>>
    total: number
    nextCursor: string | null
    prevCursor: string | null
  }
  entryById: Record<string, Record<string, unknown>>
  sessions?: {
    sessions: Array<Record<string, unknown>>
    total: number
  }
  stats?: Record<string, unknown>
  status?: Record<string, unknown>
  wsMessages?: Array<MockSocketMessage>
}

function repeatLog(label: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${label} line ${index + 1}`).join("\n")
}

export function createHistoryUiScenario(): HistoryUiScenario {
  const primarySummary = {
    id: "req-history-primary",
    sessionId: "sess-abc-123456789",
    rawPath: "/v1/responses",
    startedAt: BASE_TIMESTAMP - 4_500,
    endedAt: BASE_TIMESTAMP,
    endpoint: "openai-responses",
    state: "completed",
    active: false,
    lastUpdatedAt: BASE_TIMESTAMP,
    queueWaitMs: 320,
    attemptCount: 2,
    currentStrategy: "network-retry",
    requestModel: "gpt-5.4",
    stream: true,
    messageCount: 3,
    responseModel: "gpt-5.4-2026-03-05",
    responseSuccess: true,
    usage: {
      input_tokens: 1200,
      output_tokens: 140,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 50,
    },
    durationMs: 4500,
    previewText: "Summarize the build failures and recommend the next fix.",
    searchText: "summarize build failures next fix",
  }

  const addedSummary = {
    id: "req-history-added",
    sessionId: "sess-ws-9999",
    rawPath: "/v1/messages",
    startedAt: BASE_TIMESTAMP + 600,
    endedAt: BASE_TIMESTAMP + 1_000,
    endpoint: "anthropic-messages",
    state: "completed",
    active: false,
    lastUpdatedAt: BASE_TIMESTAMP + 1_000,
    queueWaitMs: 40,
    attemptCount: 1,
    currentStrategy: "direct",
    requestModel: "claude-sonnet-4.6",
    stream: false,
    messageCount: 1,
    responseModel: "claude-sonnet-4.6",
    responseSuccess: true,
    usage: {
      input_tokens: 90,
      output_tokens: 45,
    },
    durationMs: 620,
    previewText: "Fresh websocket activity arrived after the initial page load.",
    searchText: "fresh websocket activity arrived",
  }

  const primaryEntry = {
    id: primarySummary.id,
    sessionId: primarySummary.sessionId,
    rawPath: primarySummary.rawPath,
    startedAt: BASE_TIMESTAMP - 4_500,
    endedAt: BASE_TIMESTAMP,
    endpoint: "openai-responses",
    state: "completed",
    active: false,
    lastUpdatedAt: BASE_TIMESTAMP,
    queueWaitMs: 320,
    attemptCount: 2,
    currentStrategy: "network-retry",
    durationMs: 4500,
    transport: "upstream-ws-fallback",
    warningMessages: [
      {
        code: "rewritten_payload",
        message: "The request payload was rewritten before the retry attempt.",
      },
    ],
    request: {
      model: "gpt-5.4",
      stream: true,
      max_tokens: 2000,
      temperature: 0.2,
      system: "You are a build triage assistant.\n" + repeatLog("system guidance", 20),
      messages: [
        {
          role: "user",
          content: "Summarize the build failures and recommend the next fix.",
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "read_logs",
              input: { path: "build.log" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: repeatLog("typescript failure", 180),
            },
          ],
        },
      ],
      tools: [
        {
          name: "read_logs",
          description: "Read build logs",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        },
      ],
    },
    effectiveRequest: {
      model: "gpt-5.4",
      format: "openai-responses",
      messageCount: 3,
      system: "You are a rewritten build triage assistant.\n" + repeatLog("rewritten guidance", 16),
      messages: [
        {
          role: "user",
          content: "Summarize the TypeScript failures and propose the very next edit.",
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "read_logs",
              input: { path: "build.log" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: repeatLog("rewritten typescript failure", 180),
            },
          ],
        },
      ],
    },
    wireRequest: {
      model: "gpt-5.4",
      format: "openai-responses",
      messageCount: 3,
      headers: {
        authorization: "Bearer [redacted]",
        "x-request-id": "wire-req-123",
      },
    },
    response: {
      success: true,
      model: "gpt-5.4-2026-03-05",
      usage: {
        input_tokens: 1200,
        output_tokens: 140,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 50,
        output_tokens_details: {
          reasoning_tokens: 30,
        },
      },
      stop_reason: "completed",
      content: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "The failures cluster around the history export surface and a missing session helper export. Fix the export first, rerun typecheck, then confirm the history modal stack in the browser.",
          },
        ],
      },
      headers: {
        "x-upstream-request-id": "resp-123",
      },
    },
    pipelineInfo: {
      truncation: {
        originalMessages: 12,
        droppedMessages: 9,
        keptMessages: 3,
        strategy: "keep-last-turns",
      },
    },
    attempts: [
      {
        index: 0,
        strategy: "direct",
        durationMs: 1200,
        transport: "upstream-ws",
        error: "idle timeout",
      },
      {
        index: 1,
        strategy: "network-retry",
        durationMs: 3300,
        transport: "upstream-ws-fallback",
      },
    ],
  }

  const addedEntry = {
    id: addedSummary.id,
    sessionId: addedSummary.sessionId,
    rawPath: addedSummary.rawPath,
    startedAt: BASE_TIMESTAMP + 600,
    endedAt: BASE_TIMESTAMP + 1_000,
    endpoint: "anthropic-messages",
    state: "completed",
    active: false,
    lastUpdatedAt: BASE_TIMESTAMP + 1_000,
    queueWaitMs: 40,
    attemptCount: 1,
    currentStrategy: "direct",
    durationMs: 620,
    transport: "http",
    request: {
      model: "claude-sonnet-4.6",
      stream: false,
      messages: [
        {
          role: "user",
          content: "Fresh websocket activity arrived after the initial page load.",
        },
      ],
    },
    response: {
      success: true,
      model: "claude-sonnet-4.6",
      usage: {
        input_tokens: 90,
        output_tokens: 45,
      },
      stop_reason: "end_turn",
      content: {
        role: "assistant",
        content: "The UI inserted this request from a websocket event.",
      },
    },
  }

  return {
    summaryResult: {
      entries: [primarySummary],
      total: 1,
      nextCursor: null,
      prevCursor: null,
    },
    entryById: {
      [primarySummary.id]: primaryEntry,
      [addedSummary.id]: addedEntry,
    },
    sessions: {
      sessions: [
        {
          id: primarySummary.sessionId,
          startTime: BASE_TIMESTAMP - 5_000,
          lastActivity: BASE_TIMESTAMP,
          requestCount: 1,
          totalInputTokens: 1200,
          totalOutputTokens: 140,
          models: ["gpt-5.4"],
          endpoints: ["openai-responses"],
        },
      ],
      total: 1,
    },
    stats: {
      totalRequests: 2,
      successfulRequests: 2,
      failedRequests: 0,
      totalInputTokens: 1290,
      totalOutputTokens: 185,
      averageDurationMs: 2560,
      modelDistribution: {
        "gpt-5.4": 1,
        "claude-sonnet-4.6": 1,
      },
      endpointDistribution: {
        "openai-responses": 1,
        "anthropic-messages": 1,
      },
      recentActivity: [
        { hour: "09:00", count: 2 },
      ],
      activeSessions: 1,
    },
    status: {
      status: "healthy",
      uptime: 1234,
      activeRequests: {
        count: 1,
      },
      shutdown: {
        phase: "idle",
      },
      rateLimiter: {
        enabled: true,
        mode: "normal",
        queueLength: 0,
        consecutiveSuccesses: 3,
        rateLimitedAt: null,
        config: {},
      },
    },
    wsMessages: [
      {
        topic: "requests",
        delayMs: 10,
        message: {
          type: "active_request_changed",
          timestamp: BASE_TIMESTAMP + 10,
          data: {
            action: "created",
            activeCount: 1,
            request: {
              id: "req-live-1",
              endpoint: "openai-responses",
              rawPath: "/v1/responses",
              state: "streaming",
              startTime: BASE_TIMESTAMP - 2_000,
              durationMs: 2_000,
              model: "gpt-5.4",
              stream: true,
              attemptCount: 1,
              currentStrategy: "direct",
              queueWaitMs: 45,
            },
          },
        },
      },
      {
        topic: "history",
        delayMs: 40,
        message: {
          type: "entry_added",
          timestamp: BASE_TIMESTAMP + 40,
          data: addedSummary,
        },
      },
    ],
  }
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  })
}

export async function installHistoryUiMocks(page: Page, scenario: HistoryUiScenario): Promise<void> {
  await page.addInitScript(({ wsMessages }) => {
    const topicByType = {
      entry_added: "history",
      entry_updated: "history",
      stats_updated: "history",
      history_cleared: "history",
      session_deleted: "history",
      active_request_changed: "requests",
      rate_limiter_changed: "status",
      shutdown_phase_changed: "status",
    } as Record<string, string>

    class MockWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      url: string
      readyState = MockWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      private listeners = new Map<string, Set<(event: Event) => void>>()
      private topics: Array<string> | null = null

      constructor(url: string) {
        this.url = url
        setTimeout(() => {
          this.readyState = MockWebSocket.OPEN
          this.dispatch("open", new Event("open"))
        }, 0)
      }

      addEventListener(type: string, listener: (event: Event) => void): void {
        const current = this.listeners.get(type) ?? new Set()
        current.add(listener)
        this.listeners.set(type, current)
      }

      removeEventListener(type: string, listener: (event: Event) => void): void {
        this.listeners.get(type)?.delete(listener)
      }

      send(raw: string): void {
        let payload: { type?: string; topics?: Array<string> } | null = null
        try {
          payload = JSON.parse(raw) as { type?: string; topics?: Array<string> }
        } catch {
          payload = null
        }

        if (payload?.type === "subscribe") {
          this.topics = Array.isArray(payload.topics) ? payload.topics : null
          this.emitMessage({
            type: "connected",
            data: { clientCount: 1 },
            timestamp: Date.now(),
          })

          let elapsed = 0
          for (const item of wsMessages as Array<{ topic?: string; delayMs?: number; message: { type: string; data: unknown; timestamp: number } }>) {
            const topic = item.topic ?? topicByType[item.message.type]
            if (this.topics && topic && !this.topics.includes(topic)) continue
            elapsed += item.delayMs ?? 0
            setTimeout(() => this.emitMessage(item.message), elapsed)
          }
        }
      }

      close(): void {
        this.readyState = MockWebSocket.CLOSED
        this.dispatch("close", new CloseEvent("close"))
      }

      private emitMessage(message: { type: string; data: unknown; timestamp: number }): void {
        const event = new MessageEvent("message", { data: JSON.stringify(message) })
        this.dispatch("message", event)
      }

      private dispatch(type: string, event: Event): void {
        const handler =
          type === "open" ? this.onopen
            : type === "message" ? this.onmessage
              : type === "close" ? this.onclose
                : this.onerror
        handler?.(event as never)
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event)
        }
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: MockWebSocket,
    })
  }, { wsMessages: scenario.wsMessages ?? [] })

  await page.route("**/history/api/entries?*", async (route) => {
    await fulfillJson(route, scenario.summaryResult)
  })

  await page.route("**/history/api/stats", async (route) => {
    await fulfillJson(route, scenario.stats ?? {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      averageDurationMs: 0,
      modelDistribution: {},
      endpointDistribution: {},
      recentActivity: [],
      activeSessions: 0,
    })
  })

  await page.route("**/history/api/sessions", async (route) => {
    await fulfillJson(route, scenario.sessions ?? { sessions: [], total: 0 })
  })

  await page.route("**/history/api/entries/*", async (route) => {
    const url = new URL(route.request().url())
    const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "")
    const entry = scenario.entryById[id]

    if (!entry) {
      await fulfillJson(route, { error: `Entry not found: ${id}` }, 404)
      return
    }

    await fulfillJson(route, entry)
  })

  await page.route("**/api/status", async (route) => {
    await fulfillJson(route, scenario.status ?? {
      status: "healthy",
      uptime: 1,
      activeRequests: { count: 0 },
      shutdown: { phase: "idle" },
      rateLimiter: {
        enabled: false,
        mode: "normal",
        queueLength: 0,
        consecutiveSuccesses: 0,
        rateLimitedAt: null,
        config: {},
      },
    })
  })
}

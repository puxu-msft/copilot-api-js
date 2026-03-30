import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { getCopilotToken, getCopilotUsage } from "~/lib/token/copilot-client"
import { restoreStateForTests, setStateForTests, snapshotStateForTests } from "~/lib/state"

const originalFetch = globalThis.fetch

describe("copilot token client", () => {
  const originalState = snapshotStateForTests()

  beforeEach(() => {
    setStateForTests({
      githubToken: "gh-test-token",
      vsCodeVersion: "1.104.3",
      accountType: "individual",
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreStateForTests(originalState)
  })

  test("fetches the Copilot token with GitHub headers", async () => {
    const fetchMock = mock(async () =>
      new Response(
        JSON.stringify({
          token: "copilot-test-token",
          expires_at: 123,
          refresh_in: 45,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await getCopilotToken()

    expect(result).toMatchObject({
      token: "copilot-test-token",
      expires_at: 123,
      refresh_in: 45,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>
    const firstCall = calls[0]
    expect(firstCall).toBeDefined()
    const url = firstCall[0]
    const init = firstCall[1]
    expect(url).toBe("https://api.github.com/copilot_internal/v2/token")
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      authorization: "token gh-test-token",
      "editor-version": "vscode/1.104.3",
      "x-github-api-version": "2025-04-01",
    })
    expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal)
  })

  test("throws HTTPError when the Copilot token endpoint fails", async () => {
    globalThis.fetch = mock(async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch

    await expect(getCopilotToken()).rejects.toBeInstanceOf(HTTPError)
  })

  test("fetches Copilot usage with GitHub headers", async () => {
    const fetchMock = mock(async () =>
      new Response(
        JSON.stringify({
          access_type_sku: "copilot",
          analytics_tracking_id: "track-1",
          assigned_date: "2026-03-01",
          can_signup_for_limited: false,
          chat_enabled: true,
          copilot_plan: "individual",
          organization_login_list: [],
          organization_list: [],
          quota_reset_date: "2026-04-01",
          quota_snapshots: {
            chat: {
              entitlement: 1,
              overage_count: 0,
              overage_permitted: false,
              percent_remaining: 100,
              quota_id: "chat",
              quota_remaining: 10,
              remaining: 10,
              unlimited: false,
            },
            completions: {
              entitlement: 1,
              overage_count: 0,
              overage_permitted: false,
              percent_remaining: 90,
              quota_id: "completions",
              quota_remaining: 9,
              remaining: 9,
              unlimited: false,
            },
            premium_interactions: {
              entitlement: 1,
              overage_count: 0,
              overage_permitted: false,
              percent_remaining: 80,
              quota_id: "premium",
              quota_remaining: 8,
              remaining: 8,
              unlimited: false,
            },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await getCopilotUsage()

    expect(result.copilot_plan).toBe("individual")
    expect(result.quota_snapshots.chat.remaining).toBe(10)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>
    const firstCall = calls[0]
    expect(firstCall).toBeDefined()
    const url = firstCall[0]
    const init = firstCall[1]
    expect(url).toBe("https://api.github.com/copilot_internal/user")
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      authorization: "token gh-test-token",
      "x-github-api-version": "2025-04-01",
    })
  })

  test("throws HTTPError when the usage endpoint fails", async () => {
    globalThis.fetch = mock(async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch

    await expect(getCopilotUsage()).rejects.toBeInstanceOf(HTTPError)
  })
})

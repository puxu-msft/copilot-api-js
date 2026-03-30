import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { cacheModels, getModels } from "~/lib/models/client"
import { restoreStateForTests, setStateForTests, snapshotStateForTests, state } from "~/lib/state"

const originalFetch = globalThis.fetch

describe("models client", () => {
  const originalState = snapshotStateForTests()

  beforeEach(() => {
    setStateForTests({
      accountType: "individual",
      copilotToken: "copilot-test-token",
      vsCodeVersion: "1.100.0",
      fetchTimeout: 0,
      models: undefined,
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreStateForTests(originalState)
  })

  test("getModels fetches models from Copilot", async () => {
    const fetchMock = mock(async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "gpt-4o",
              name: "GPT-4o",
              vendor: "OpenAI",
              object: "model",
              model_picker_enabled: true,
              preview: false,
              version: "gpt-4o",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await getModels()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.length).toBe(1)
    expect(result.object).toBe("list")
    expect(result.data[0]?.id).toBe("gpt-4o")
  })

  test("cacheModels updates global model state and indexes", async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "claude-sonnet-4.6",
              name: "Claude Sonnet 4.6",
              vendor: "Anthropic",
              object: "model",
              model_picker_enabled: true,
              preview: false,
              version: "claude-sonnet-4.6",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as unknown as typeof fetch

    await cacheModels()

    expect(state.models?.data[0]?.id).toBe("claude-sonnet-4.6")
    expect(state.modelIndex.get("claude-sonnet-4.6")?.vendor).toBe("Anthropic")
  })

  test("getModels throws HTTPError when Copilot returns a failure response", async () => {
    globalThis.fetch = mock(async () => new Response("upstream failed", { status: 502 })) as unknown as typeof fetch

    await expect(getModels()).rejects.toBeInstanceOf(HTTPError)
  })
})

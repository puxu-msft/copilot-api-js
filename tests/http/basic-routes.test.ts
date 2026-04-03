import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { type StateSnapshot, restoreStateForTests, setModels, setStateForTests, snapshotStateForTests } from "~/lib/state"
import { HTTPError } from "~/lib/error"

import { mockModel } from "../helpers/factories"
import { createFullTestApp, createMinimalApp } from "../helpers/test-app"
import { resetTestRuntime } from "../helpers/test-bootstrap"

interface HealthResponseBody {
  status: "healthy" | "unhealthy"
  checks: {
    copilotToken: boolean
    githubToken: boolean
    models: boolean
  }
}

interface ModelsListResponseBody {
  object: string
  data: Array<{
    id: string
    object: string
    vendor: string
    name: string
    version: string
    preview: boolean
    model_picker_enabled: boolean
    is_chat_default: boolean
    is_chat_fallback: boolean
  }>
}

const app = createFullTestApp()
const originalFetch = globalThis.fetch

describe("basic HTTP routes", () => {
  let snapshot: StateSnapshot

  beforeEach(() => {
    snapshot = snapshotStateForTests()
    setModels({
      object: "list",
      data: [
        mockModel("claude-sonnet-4.6", {
          vendor: "Anthropic",
          supported_endpoints: ["/v1/messages"],
        }),
      ],
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreStateForTests(snapshot)
    resetTestRuntime()
  })

  test("GET / returns 200 with server banner", async () => {
    const res = await app.request("/")

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("Server running")
  })

  test("GET /health returns 503 when tokens are missing", async () => {
    setStateForTests({ copilotToken: undefined, githubToken: undefined })

    const res = await app.request("/health")
    const body = (await res.json()) as HealthResponseBody

    expect(res.status).toBe(503)
    expect(body).toEqual({
      status: "unhealthy",
      checks: {
        copilotToken: false,
        githubToken: false,
        models: true,
      },
    })
  })

  test("GET /health returns 200 when tokens are present", async () => {
    setStateForTests({ copilotToken: "copilot-test", githubToken: "ghp_test" })

    const res = await app.request("/health")
    const body = (await res.json()) as HealthResponseBody

    expect(res.status).toBe(200)
    expect(body.status).toBe("healthy")
    expect(body.checks).toEqual({
      copilotToken: true,
      githubToken: true,
      models: true,
    })
  })

  test("GET /models returns upstream model data as-is", async () => {
    const res = await app.request("/models")
    const body = (await res.json()) as ModelsListResponseBody

    expect(res.status).toBe(200)
    expect(body.object).toBe("list")
    expect(body).not.toHaveProperty("has_more")
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({
      id: "claude-sonnet-4.6",
      object: "model",
      vendor: "Anthropic",
      name: "claude-sonnet-4.6",
      is_chat_default: false,
      is_chat_fallback: false,
    })
    expect(body.data[0]).not.toHaveProperty("type")
    expect(body.data[0]).not.toHaveProperty("created")
    expect(body.data[0]).not.toHaveProperty("created_at")
    expect(body.data[0]).not.toHaveProperty("owned_by")
    expect(body.data[0]).not.toHaveProperty("display_name")
  })

  test("GET /models?detail=true remains equivalent to the default response", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          version: "2025-01-01",
          supported_endpoints: ["/chat/completions", "/responses"],
          billing: { is_premium: true, multiplier: 10 },
          is_chat_default: false,
          is_chat_fallback: false,
        }),
      ],
    })

    const defaultRes = await app.request("/models")
    const detailRes = await app.request("/models?detail=true")
    const defaultBody = (await defaultRes.json()) as ModelsListResponseBody
    const detailBody = (await detailRes.json()) as ModelsListResponseBody

    expect(defaultRes.status).toBe(200)
    expect(detailRes.status).toBe(200)
    expect(detailBody).toEqual(defaultBody)
    expect(detailBody.data[0]).toMatchObject({
      id: "gpt-4o",
      version: "2025-01-01",
      supported_endpoints: ["/chat/completions", "/responses"],
      billing: { is_premium: true, multiplier: 10 },
    })
  })

  test("GET /models/:id returns upstream model data as-is", async () => {
    setModels({
      object: "list",
      data: [
        mockModel("gpt-4o", {
          vendor: "OpenAI",
          version: "2025-01-01",
          supported_endpoints: ["/chat/completions", "/responses"],
          is_chat_default: false,
          is_chat_fallback: false,
        }),
      ],
    })

    const res = await app.request("/models/gpt-4o")
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      id: "gpt-4o",
      object: "model",
      vendor: "OpenAI",
      version: "2025-01-01",
      supported_endpoints: ["/chat/completions", "/responses"],
    })
    expect(body).not.toHaveProperty("type")
  })

  test("GET /models/:id returns a model_not_found payload for unknown models", async () => {
    const res = await app.request("/models/does-not-exist")
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body).toEqual({
      error: {
        message: "The model 'does-not-exist' does not exist",
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found",
      },
    })
  })

  test("GET /models fetches and caches models when state is empty", async () => {
    setStateForTests({ models: undefined })
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "fetched-model",
              name: "Fetched Model",
              vendor: "OpenAI",
              object: "model",
              model_picker_enabled: true,
              preview: false,
              version: "fetched-model",
              is_chat_default: false,
              is_chat_fallback: false,
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as unknown as typeof fetch

    const res = await app.request("/models")
    const body = (await res.json()) as ModelsListResponseBody

    expect(res.status).toBe(200)
    expect(body.data[0]?.id).toBe("fetched-model")
  })

  test("GET /models/:id fetches and caches models when state is empty", async () => {
    setStateForTests({ models: undefined })
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "fetched-model",
              name: "Fetched Model",
              vendor: "OpenAI",
              object: "model",
              model_picker_enabled: true,
              preview: false,
              version: "fetched-model",
              is_chat_default: false,
              is_chat_fallback: false,
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )) as unknown as typeof fetch

    const res = await app.request("/models/fetched-model")
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      id: "fetched-model",
      object: "model",
      is_chat_default: false,
      is_chat_fallback: false,
    })
    expect(body).not.toHaveProperty("type")
  })

  test("GET /models forwards model cache failures through the shared error handler", async () => {
    setStateForTests({ models: undefined })
    globalThis.fetch = mock(async () => new Response("upstream failed", { status: 502 })) as unknown as typeof fetch

    const res = await app.request("/models")
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(body).toMatchObject({
      error: {
        type: "error",
        message: "upstream failed",
      },
    })
  })

  test("GET /models/:id forwards model cache failures through the shared error handler", async () => {
    setStateForTests({ models: undefined })
    globalThis.fetch = mock(async () => new Response("upstream failed", { status: 502 })) as unknown as typeof fetch

    const res = await app.request("/models/fetched-model")
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(body).toMatchObject({
      error: {
        type: "error",
        message: "upstream failed",
      },
    })
  })

  test("GET /favicon.ico returns 204 silently", async () => {
    const res = await app.request("/favicon.ico")

    expect(res.status).toBe(204)
    expect(await res.text()).toBe("")
  })

  test("GET /nonexistent returns 404 JSON", async () => {
    const res = await app.request("/nonexistent")

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Not Found" })
  })
})

describe("global error forwarding", () => {
  test("forwards HTTPError through the shared error handler", async () => {
    const app = createMinimalApp((testApp) => {
      testApp.get("/boom", () => {
        throw new HTTPError("Bad upstream", 429, JSON.stringify({ error: { message: "Too many requests" } }))
      })
    })

    const res = await app.request("/boom")
    const body = await res.json()

    expect(res.status).toBe(429)
    expect(body).toEqual({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "Too many requests",
      },
    })
  })
})

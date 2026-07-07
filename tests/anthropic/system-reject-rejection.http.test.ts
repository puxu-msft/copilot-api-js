import {
  //
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  //
  isSystemRejectModelLearned,
  resetAnthropicFeatureNegotiationForTesting,
} from "~/lib/anthropic/feature-negotiation"
import { PATHS } from "~/lib/config/paths"
import {
  //
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"

// End-to-end probe for the reactive system-reject self-healing strategy on the
// Anthropic path (RFC gap A): a request carrying an inline `role:"system"`
// message against a model that is NOT in the proactive reject set (so the first
// hop ships role:system unmodified) must, after the reactive retry,
// (1) succeed with 200, (2) re-send WITHOUT any `role:"system"` message (the
// re-sanitized baseline converts it), and (3) fixate the model in the learned
// reject set so future first hops pre-strip proactively.

interface CapturedMessage {
  role: string
}

const rolesPerCall: Array<Array<string>> = []

// Mirrors the RAW upstream wire body: JSON.stringify escapes the inner quotes,
// so the responseText literally contains `Unexpected role \"system\"`.
const SYSTEM_REJECT_400_BODY = JSON.stringify({
  error: {
    type: "invalid_request_error",
    message: 'Unexpected role "system". The Messages API accepts a top-level system parameter, not inline system messages.',
  },
})

function buildOkBody(model: string): string {
  return JSON.stringify({
    id: "msg-sysreject-test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2 },
  })
}

const upstreamFetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string; messages?: Array<CapturedMessage> }) : {}

  if (url.endsWith("/v1/messages")) {
    rolesPerCall.push((payload.messages ?? []).map((m) => m.role))
    // First call rejects inline role:system; subsequent calls (post re-sanitize) succeed.
    if (rolesPerCall.length === 1) {
      return new Response(SYSTEM_REJECT_400_BODY, { status: 400, headers: { "content-type": "application/json" } })
    }
    return new Response(buildOkBody(payload.model ?? "unknown"), { status: 200, headers: { "content-type": "application/json" } })
  }

  throw new Error(`unexpected upstream URL in mock: ${url}`)
})

const { createFullTestApp } = await import("../helpers/test-app")

const app = createFullTestApp()

let tmpDir = ""
let realPath = ""

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neg-sysreject-http-"))
  realPath = PATHS.NEGOTIATION_STATES
  PATHS.NEGOTIATION_STATES = path.join(tmpDir, "negotiation-states.json")
})

afterAll(async () => {
  PATHS.NEGOTIATION_STATES = realPath
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("POST /v1/messages — reactive system-reject self-healing", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    rolesPerCall.length = 0
    upstreamFetchMock.mockClear()
    setStateForTests({
      copilotToken: "test-token",
      accountType: "individual",
      vsCodeVersion: "1.100.0",
      responseHeaderTimeout: 0,
      // Empty the PROACTIVE reject set so the first hop ships role:system
      // unmodified — the reactive strategy must learn the model from the 400.
      systemRejectModels: [],
    })
    applyFetchMock(upstreamFetchMock)
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

  afterEach(async () => {
    await resetAnthropicFeatureNegotiationForTesting()
  })

  test('400 Unexpected role "system" → learns the model, re-sanitizes the baseline, retries clean', async () => {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        messages: [
          { role: "system", content: "you are a helpful assistant" },
          { role: "user", content: "hi" },
        ],
        max_tokens: 64,
        stream: false,
      }),
    })

    expect(res.status).toBe(200)

    // Two upstream hops: first carried role:system (rejected), second re-sanitized.
    expect(rolesPerCall.length).toBe(2)
    expect(rolesPerCall[0]).toContain("system")
    expect(rolesPerCall[1]).not.toContain("system")

    // Learned reject set fixated so future first hops proactively convert.
    expect(isSystemRejectModelLearned("claude-sonnet-4.6")).toBe(true)
  })
})

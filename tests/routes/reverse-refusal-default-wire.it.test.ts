/**
 * Reverse `@messages` legs under the DEFAULT refusal mode — what the CLIENT actually receives.
 *
 * `reverse-contentless-refusal.it.test.ts` is the six-cell VERDICT matrix (failed / upstreamSucceeded
 * / feature). It says nothing about the wire, so until this file the repo had no oracle for the
 * question the whole refusal work exists to answer: does the client get a turn it can continue from?
 *
 * The answer splits along streaming, and the split is the point:
 *
 *   - STREAMING (3 legs) ALREADY suppress. Not because anything cross-protocol was built: the
 *     per-frame rewrite chain gates on `targetEndpoint === /v1/messages`, which a reverse leg
 *     satisfies, so the Anthropic frames are rewritten BEFORE the reverse translator sees them and
 *     each target protocol renders an ordinary turn for free. Pinned here because it is behavior we
 *     must not silently lose.
 *   - NON-STREAMING (3 legs) do NOT. The whole-response chain lives in `driver.runResponseWhole`,
 *     whose only production call site is the direct Anthropic handler; the reverse non-streaming
 *     paths call `driver.runResponseNonStreaming` (a pure render) and never the rewrite chain. So the
 *     client meets the untouched Anthropic→target translation of a refusal. These three tests
 *     CHARACTERIZE the gap — when the deferred suppression task lands they must flip to match the
 *     streaming three, and their failure is the signal that it did.
 *
 * On pinning modes here: don't. The repo-root `config.yaml` pins `refusal_sse_rewrite: end_turn` and
 * the routes re-apply config per request (`applyConfigToState`), so a `setStateForTests` mode pin is
 * silently overwritten before the request-scoped policy freezes. Mutation-control this file by
 * breaking the production rewrite (e.g. `refusalRewrite.appliesTo → false`), not by flipping state.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { setModels } from "~/lib/models/cache"
import {
  //
  setDisabledModels,
  setStateForTests,
} from "~/lib/state"

import {
  //
  MESSAGE_STOP_FRAME,
  anthropicSseFrame,
  messageStartFrame,
} from "../helpers/anthropic-frames"
import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { applyFetchMock } from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"

const MODEL = "claude-opus-4.8"
const STOP_DETAILS = { type: "refusal", category: "cyber", explanation: "diagnostic only" }

/** A contentless refusal: one encrypted-thinking block (no client-visible content) + stop_reason refusal. */
const REFUSAL_CONTENT = [{ type: "thinking", thinking: "", signature: "SIG-REFUSAL" }]

const STREAM_FRAMES = [
  messageStartFrame({ id: "msg_probe", model: MODEL, inputTokens: 20 }),
  anthropicSseFrame("content_block_start", { type: "content_block_start", index: 0, content_block: REFUSAL_CONTENT[0] }),
  anthropicSseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
  anthropicSseFrame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "refusal", stop_sequence: null, stop_details: STOP_DETAILS },
    usage: { output_tokens: 1 },
  }),
  MESSAGE_STOP_FRAME,
]

const upstreamFetchMock = mock((_input: string | URL | Request, init?: RequestInit) => {
  const streaming = typeof init?.body === "string" && (JSON.parse(init.body) as { stream?: boolean }).stream === true
  if (streaming) return Promise.resolve(createSseResponse(STREAM_FRAMES))
  return Promise.resolve(
    new Response(
      JSON.stringify({
        id: "msg_probe",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: REFUSAL_CONTENT,
        stop_reason: "refusal",
        stop_details: STOP_DETAILS,
        usage: { input_tokens: 20, output_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  )
})

const { createFullTestApp } = await import("../helpers/test-app")
const app = createFullTestApp()

type Leg = "cc" | "responses" | "gemini"

function request(leg: Leg, stream: boolean): Promise<Response> {
  const sessionId = `reverse-default-${leg}-${stream ? "stream" : "nonstream"}`
  const headers = { "Content-Type": "application/json", "x-session-id": sessionId }
  if (leg === "cc")
    return Promise.resolve(
      app.request("/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: `${MODEL}@messages`, messages: [{ role: "user", content: "probe" }], stream }),
      }),
    )
  if (leg === "responses")
    return Promise.resolve(
      app.request("/responses", { method: "POST", headers, body: JSON.stringify({ model: `${MODEL}@messages`, input: "probe", stream }) }),
    )
  return Promise.resolve(
    app.request(`/v1beta/models/${MODEL}@messages:${stream ? "streamGenerateContent" : "generateContent"}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "probe" }] }] }),
    }),
  )
}

describe("reverse @messages contentless refusal — client wire under the DEFAULT mode", () => {
  useIsolatedRuntime()

  beforeEach(() => {
    upstreamFetchMock.mockClear()
    applyFetchMock(upstreamFetchMock)
    setDisabledModels([])
    setModels({
      object: "list",
      data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages", "/chat/completions", "/responses"] })],
    })
    // No `refusalSseRewrite` override on purpose. It would not work anyway: the repo-root `config.yaml`
    // pins `refusal_sse_rewrite: end_turn`, and the routes re-apply config per request
    // (`applyConfigToState`), so a `setStateForTests` mode pin is silently overwritten before the
    // request-scoped policy freezes. Characterizing the DEFAULT is both the honest and the only
    // reliable thing this level can do.
    setStateForTests({ copilotToken: "tok" })
  })

  // ── STREAMING: suppression already reaches all three reverse legs ───────────────────────────────
  // Not "already implemented cross-protocol" — the Anthropic frames are rewritten BEFORE the reverse
  // translator runs, so each target protocol renders an ordinary assistant turn for free.

  test("cc streaming: normal `stop` turn carrying the end_turn text", async () => {
    const body = await (await request("cc", true)).text()
    const chunks = body
      .split("\n")
      .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
      .map((line) => JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> })

    expect(chunks.flatMap((c) => c.choices?.map((ch) => ch.finish_reason) ?? []).filter(Boolean)).toEqual(["stop"])
    // The substance of suppression: the turn SAYS something (exact wording is config-driven).
    expect(chunks.flatMap((c) => c.choices?.map((ch) => ch.delta?.content ?? "") ?? []).join("").length).toBeGreaterThan(0)
    expect(body).toContain("data: [DONE]")
  })

  test("responses streaming: completed turn, no `incomplete` refusal status", async () => {
    const body = await (await request("responses", true)).text()
    expect(body).not.toContain('"reason":"refusal"')
    expect(body).toContain("response.completed")
  })

  test("gemini streaming: STOP finish reason + a spoken turn, not a SAFETY block", async () => {
    const body = await (await request("gemini", true)).text()
    expect(body).toContain('"finishReason":"STOP"')
    expect(body).not.toContain("SAFETY")
    // Substantive: the model "spoke" — the suppression text rode through as a normal text part.
    const parts = [...body.matchAll(/"text":"([^"]*)"/g)].map((m) => m[1] ?? "")
    expect(parts.join("").length).toBeGreaterThan(0)
  })

  // ── NON-STREAMING: the gap. `driver.runResponseWhole` — which owns the whole-response refusal
  // rewrite — has exactly ONE production call site (the direct Anthropic handler). The three reverse
  // non-streaming paths call `driver.runResponseNonStreaming` (a pure render) and never the rewrite
  // chain, so the client meets the untouched Anthropic→target translation of a refusal.
  // FLIP THESE when the deferred suppression task lands; their failure IS the landing signal.

  test("cc non-streaming: NOT suppressed (content_filter + null content)", async () => {
    const body = (await (await request("cc", false)).json()) as { choices: Array<{ message: { content: string | null }; finish_reason: string }> }
    expect(body.choices[0]?.finish_reason).toBe("content_filter")
    expect(body.choices[0]?.message.content).toBeNull()
  })

  test("responses non-streaming: NOT suppressed (incomplete/refusal)", async () => {
    const body = (await (await request("responses", false)).json()) as { status?: string; incomplete_details?: { reason?: string } }
    expect(body.status).toBe("incomplete")
    expect(body.incomplete_details?.reason).toBe("refusal")
  })

  test("gemini non-streaming: NOT suppressed (SAFETY + an empty turn)", async () => {
    const body = (await (await request("gemini", false)).json()) as {
      candidates?: Array<{ finishReason?: string; content?: { parts?: Array<unknown> } }>
    }
    // Asserted positively (`SAFETY`, empty parts) rather than as `not STOP`: a negative on a field
    // that could simply be absent would pass without the leg ever running.
    expect(body.candidates?.[0]?.finishReason).toBe("SAFETY")
    expect(body.candidates?.[0]?.content?.parts).toEqual([])
  })
})

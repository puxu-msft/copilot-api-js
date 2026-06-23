/**
 * Stage A Task0 — activated-state response-rewrite golden baseline (byte-lock).
 *
 * The byte-critical streaming golden in `anthropic-v4.http.test.ts` only locks
 * two *no-op-rewrite* passthrough streams (ok / thinking). This file locks the
 * ACTIVATED response-rewrite paths the handler-v4 pump runs — the byte-equivalence
 * basis for the Stage A `rewrite-registry` migration (RFC §7): every later
 * migration commit must keep these green.
 *
 * Covered activations (each fixture drives the real activation path, not a
 * passthrough):
 *   S1  server-tool-filter suppress + index densify (server_tool_use idx0 dropped,
 *       text idx1 → client idx0).
 *   S2  tool-input-decode buffer/flush (AskUserQuestion `questions` stringified
 *       array → decoded + question backfilled at content_block_stop).
 *   S3a recover-tool-call CANDIDATE → COMMIT (tier A, stop_reason=tool_use →
 *       synthesized tool_use).
 *   S3b recover-tool-call ROLLBACK (candidate interrupted by a fresh
 *       content_block_start → `[stopFrame, ...bufferedFrames]`, recover-stream.ts:93-98).
 *   S4  recover + decode both buffering at stream end → double flush
 *       (handler-v4.ts:655-663): recover.flush feeds decode, then decode.flush.
 *   S5  recover × filter index-space interaction (synth tool_use at upstream
 *       maxIndexSeen+1, then filter densifies past the dropped server tool).
 *   S6  non-streaming variants (renderNonStreamingV4 whole-response helpers):
 *       server-tool filter / tool-input decode / recover.
 *
 * Heartbeat isolation (Task0 item 7): every streaming case runs with the default
 * `streamKeepalivePingSec=0`, so no synthetic `ping` is ever interleaved — the
 * forwarded byte stream is deterministic. (Ping timing is covered separately by
 * `fake-sse-heartbeat.unit.test.ts`.)
 *
 * Goldens are composed from per-frame builders (escaping handled by JSON.stringify,
 * synthesized tool_use ids are sha256-deterministic) rather than transcribed
 * literals; the structure documents each transform. Captured from the current
 * handler-v4 path BEFORE any registry migration.
 */

import {
  //
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"

import { resetAnthropicFeatureNegotiationForTesting } from "~/lib/anthropic/feature-negotiation"
import { REFUSAL_RECOVERY_TEXT } from "~/lib/anthropic/recover-refusal"
import { getHistory } from "~/lib/history"
import {
  //
  setModelOverrides,
  setModels,
  setStateForTests,
} from "~/lib/state"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  applyFetchMock,
} from "../helpers/mock-fetch"
import { createSseResponse } from "../helpers/sse"
import { createFullTestApp } from "../helpers/test-app"

// ── frame builders ───────────────────────────────────────────────────────────

/** An event-named SSE frame (passthrough / filter-rewritten frames keep their upstream event name). */
function ev(event: string, obj: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
}

/** A data-only SSE frame (recoverer-synthesized frames carry no `event:` line). */
function dat(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

const DONE = "data: [DONE]\n\n"
const MODEL = "claude-sonnet-4.6"

function messageStart(): string {
  return ev("message_start", {
    type: "message_start",
    message: {
      id: "msg-golden",
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  })
}
const messageDelta = (stopReason: string): string =>
  ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } })
const messageStop = (): string => ev("message_stop", { type: "message_stop" })

// Downgrade text: residue `<function_calls>` + a single `<invoke name="search">`.
const INVOKE_TEXT = '<function_calls><invoke name="search"><parameter name="query">weather</parameter></invoke>'
// AskUserQuestion input whose `questions` is a stringified JSON array (decode target).
const ASK_INPUT = JSON.stringify({ questions: JSON.stringify([{ header: "Deploy?" }]) })
// Deterministic synthesized id: synthesizeToolUseId("search", 0, INVOKE_TEXT) (sha256-derived, stable across runs/scenarios).
const SYNTH_ID = "toolu_4J3DaoIFX52HRvUKKqdPbCOR"

const SEARCH_TOOL = { name: "search", description: "search the web", input_schema: { type: "object", properties: { query: { type: "string" } } } }

// ── upstream stream fixtures ─────────────────────────────────────────────────

function s1Frames(): Array<string> {
  return [
    messageStart(),
    ev("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "server_tool_use", id: "srvtool_1", name: "web_search", input: {} },
    }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"x"}' } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi there" } }),
    ev("content_block_stop", { type: "content_block_stop", index: 1 }),
    messageDelta("end_turn"),
    messageStop(),
    DONE,
  ]
}

function s2Frames(): Array<string> {
  return [
    messageStart(),
    ev("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: {} },
    }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ASK_INPUT.slice(0, 20) } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ASK_INPUT.slice(20) } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } }),
    ev("content_block_stop", { type: "content_block_stop", index: 1 }),
    messageDelta("tool_use"),
    messageStop(),
    DONE,
  ]
}

function s3aFrames(): Array<string> {
  return [
    messageStart(),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: INVOKE_TEXT.slice(0, 40) } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: INVOKE_TEXT.slice(40) } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    messageDelta("tool_use"),
    messageStop(),
    DONE,
  ]
}

function s3bFrames(): Array<string> {
  return [
    messageStart(),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: INVOKE_TEXT } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "actually no" } }),
    ev("content_block_stop", { type: "content_block_stop", index: 1 }),
    messageDelta("end_turn"),
    messageStop(),
    DONE,
  ]
}

function s4Frames(): Array<string> {
  return [
    messageStart(),
    ev("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: {} },
    }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ASK_INPUT } }),
    ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: INVOKE_TEXT } }),
    DONE,
  ]
}

function s5Frames(): Array<string> {
  return [
    messageStart(),
    ev("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "server_tool_use", id: "srvtool_1", name: "web_search", input: {} },
    }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"x"}' } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: INVOKE_TEXT } }),
    ev("content_block_stop", { type: "content_block_stop", index: 1 }),
    messageDelta("tool_use"),
    messageStop(),
    DONE,
  ]
}

// ── non-streaming upstream bodies ────────────────────────────────────────────

function s6FilterBody(): string {
  return JSON.stringify({
    id: "msg-ns",
    type: "message",
    role: "assistant",
    model: MODEL,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 6 },
    content: [
      { type: "server_tool_use", id: "srvtool_1", name: "web_search", input: { query: "x" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtool_1",
        content: [{ type: "web_search_result", title: "t", url: "https://e.com", encrypted_content: "z" }],
      },
      { type: "text", text: "after search" },
    ],
  })
}

function s6DecodeBody(): string {
  return JSON.stringify({
    id: "msg-ns",
    type: "message",
    role: "assistant",
    model: MODEL,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 6 },
    content: [{ type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: { questions: JSON.stringify([{ header: "Deploy?" }]) } }],
  })
}

function s6RecoverBody(): string {
  return JSON.stringify({
    id: "msg-ns",
    type: "message",
    role: "assistant",
    model: MODEL,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 6 },
    content: [{ type: "text", text: INVOKE_TEXT }],
  })
}

// ── expected forwarded goldens (composed; document each transform) ────────────

// S1: server_tool dropped, text idx1 densified → client idx0.
const S1_GOLDEN = [
  messageStart(),
  ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi there" } }),
  ev("content_block_stop", { type: "content_block_stop", index: 0 }),
  messageDelta("end_turn"),
  messageStop(),
].join("")

// S2: AskUserQuestion input decoded (questions array structured) + question backfilled.
const S2_GOLDEN = [
  messageStart(),
  ev("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: {} },
  }),
  ev("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: JSON.stringify({ questions: [{ header: "Deploy?", question: "Deploy?" }] }) },
  }),
  ev("content_block_stop", { type: "content_block_stop", index: 0 }),
  ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
  ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } }),
  ev("content_block_stop", { type: "content_block_stop", index: 1 }),
  messageDelta("tool_use"),
  messageStop(),
].join("")

// S3a: text start forwarded, deltas buffered; COMMIT emits stopFrame + synth tool_use (upstream idx1, no event line).
const S3A_GOLDEN = [
  messageStart(),
  ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ev("content_block_stop", { type: "content_block_stop", index: 0 }),
  dat({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: SYNTH_ID, name: "search", input: {} } }),
  dat({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "weather" }) } }),
  dat({ type: "content_block_stop", index: 1 }),
  messageDelta("tool_use"),
  messageStop(),
].join("")

// S3b: rollback replays `[stopFrame, ...bufferedFrames]` — stop precedes the buffered invoke-text delta (quirky order, locked).
const S3B_GOLDEN = [
  messageStart(),
  ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ev("content_block_stop", { type: "content_block_stop", index: 0 }),
  ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: INVOKE_TEXT } }),
  ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
  ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "actually no" } }),
  ev("content_block_stop", { type: "content_block_stop", index: 1 }),
  messageDelta("end_turn"),
  messageStop(),
].join("")

// S4: double flush at stream end — recover.flush emits text delta idx1, then decode.flush emits the RAW (un-decoded) AskUserQuestion delta idx0.
const S4_GOLDEN = [
  messageStart(),
  ev("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: {} },
  }),
  ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
  ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: INVOKE_TEXT } }),
  ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ASK_INPUT } }),
  // The s4 fixture ends WITHOUT message_stop, so after the recover+decode flush the proxy
  // detects the truncated stream and appends a synthetic Anthropic `error` terminator
  // (docs/rfc/upstream-stream-truncation-detection.md). The recover/decode flush bytes above
  // stay byte-locked; this frame documents the truncation terminator on the forwarded stream.
  ev("error", { type: "error", error: { type: "api_error", message: "Upstream stream truncated before completion (no message_stop)" } }),
].join("")

// S5: server_tool dropped → text idx1 densified to client idx0; synth tool_use (upstream idx2) densified to client idx1.
const S5_GOLDEN = [
  messageStart(),
  ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ev("content_block_stop", { type: "content_block_stop", index: 0 }),
  dat({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: SYNTH_ID, name: "search", input: {} } }),
  dat({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "weather" }) } }),
  dat({ type: "content_block_stop", index: 1 }),
  messageDelta("tool_use"),
  messageStop(),
].join("")

// S7 (thinking-signature-compat reshape): an embedded-signature thinking start
// (`content_block_start{thinking:"",signature:S}` + stop, NO signature_delta) is
// reshaped on the FORWARDED stream into an empty-thinking start + a synthesized
// signature_delta — the two reshaped frames both inherit the source frame's
// `event: content_block_start` line (the `{...frame, data}` quirk, locked here).
function s7Frames(): Array<string> {
  return [
    messageStart(),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "SIG-XYZ" } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } }),
    ev("content_block_stop", { type: "content_block_stop", index: 1 }),
    messageDelta("end_turn"),
    messageStop(),
    DONE,
  ]
}
const S7_GOLDEN = [
  messageStart(),
  ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
  ev("content_block_start", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG-XYZ" } }),
  ev("content_block_stop", { type: "content_block_stop", index: 0 }),
  ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
  ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } }),
  ev("content_block_stop", { type: "content_block_stop", index: 1 }),
  messageDelta("end_turn"),
  messageStop(),
].join("")

// outboundResponse.content goldens — the UPSTREAM-ORIGINAL accumulated response
// (ctx.complete → entry.outboundResponse, what lineage reads). The migration MUST
// keep this on raw upstream frames (Option A): it includes the server_tool_use the
// forwarded stream filters (S1), the downgraded TEXT the forwarded stream recovers
// (S3a), and the thinking signature on the start the forwarded stream reshapes (S7).
const S1_OUTBOUND = {
  role: "assistant",
  content: [
    { type: "server_tool_use", id: "srvtool_1", name: "web_search", input: { query: "x" } },
    { type: "text", text: "hi there" },
  ],
}
const S3A_OUTBOUND = { role: "assistant", content: [{ type: "text", text: INVOKE_TEXT }] }
const S7_OUTBOUND = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "", signature: "SIG-XYZ" },
    { type: "text", text: "answer" },
  ],
}

// S8 (recover-refusal): a thinking-only refusal (thinking start + signature_delta +
// stop, then message_delta{stop_reason:"refusal"}) is recovered on the FORWARDED
// stream by appending a synthetic text block (data-only, idx maxIndex+1) and
// rewriting the delta to end_turn (stop_details cleared). The empirical shape of
// req_1782214935133_68. Default thinking-signature-compat no-ops here (the start's
// signature is empty + a real signature_delta follows = the standard shape).
const REFUSAL_DELTA = ev("message_delta", {
  type: "message_delta",
  delta: { stop_reason: "refusal", stop_details: { type: "refusal", explanation: "x" }, stop_sequence: null },
  usage: { output_tokens: 5 },
})
function s8Frames(): Array<string> {
  return [
    messageStart(),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG-REF" } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    REFUSAL_DELTA,
    messageStop(),
    DONE,
  ]
}
const S8_GOLDEN = [
  messageStart(),
  ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
  ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG-REF" } }),
  ev("content_block_stop", { type: "content_block_stop", index: 0 }),
  ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
  ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: REFUSAL_RECOVERY_TEXT } }),
  ev("content_block_stop", { type: "content_block_stop", index: 1 }),
  ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_details: null, stop_sequence: null }, usage: { output_tokens: 5 } }),
  messageStop(),
].join("")
// Option A: the accumulated (upstream-original) response KEEPS the thinking-only
// refusal — recovery is forwarded-only (history 保留上游原始 refusal).
const S8_OUTBOUND = { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "SIG-REF" }] }

function s6RefusalBody(): string {
  return JSON.stringify({
    id: "msg-ns",
    type: "message",
    role: "assistant",
    model: MODEL,
    stop_reason: "refusal",
    stop_details: { type: "refusal", explanation: "x" },
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 6 },
    content: [{ type: "thinking", thinking: "", signature: "SIG-REF" }],
  })
}

// ── mock ─────────────────────────────────────────────────────────────────────

type Scenario = "s1" | "s2" | "s3a" | "s3b" | "s4" | "s5" | "s7" | "s8" | "s6Filter" | "s6Decode" | "s6Recover" | "s6Refusal"
let scenario: Scenario = "s1"

const upstreamMock = mock((input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : input.url
  if (!url.endsWith("/v1/messages")) throw new Error(`unexpected upstream URL: ${url}`)
  const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as { stream?: boolean }) : {}
  if (!payload.stream) {
    const body =
      scenario === "s6Filter" ? s6FilterBody()
      : scenario === "s6Decode" ? s6DecodeBody()
      : scenario === "s6Refusal" ? s6RefusalBody()
      : s6RecoverBody()
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }))
  }
  const frames =
    scenario === "s1" ? s1Frames()
    : scenario === "s2" ? s2Frames()
    : scenario === "s3a" ? s3aFrames()
    : scenario === "s3b" ? s3bFrames()
    : scenario === "s4" ? s4Frames()
    : scenario === "s7" ? s7Frames()
    : scenario === "s8" ? s8Frames()
    : s5Frames()
  return Promise.resolve(createSseResponse(frames))
})

const app = createFullTestApp()

function injectModels(): void {
  setModels({ object: "list", data: [mockModel("claude-sonnet-4.6", { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  setModelOverrides({})
}

async function postStream(extra?: Record<string, unknown>): Promise<string> {
  injectModels()
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 256, stream: true, messages: [{ role: "user", content: "go" }], ...extra }),
  })
  return res.text()
}

async function postJson(extra?: Record<string, unknown>): Promise<unknown> {
  injectModels()
  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 256, stream: false, messages: [{ role: "user", content: "go" }], ...extra }),
  })
  return res.json()
}

/** The upstream-original accumulated assistant response (ctx.complete → entry.outboundResponse). */
function lastOutboundContent(): unknown {
  return getHistory({ endpoint: "anthropic-messages" }).entries[0]?.outboundResponse?.content
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("response-rewrite activated-state golden (handler-v4, byte-lock)", () => {
  useIsolatedRuntime()

  beforeEach(async () => {
    upstreamMock.mockClear()
    setStateForTests({ copilotToken: "tok", accountType: "individual", vsCodeVersion: "1.100.0", fetchTimeout: 0 })
    applyFetchMock(upstreamMock)
    await resetAnthropicFeatureNegotiationForTesting()
  })

  test("S1 server-tool suppress + index densify (streaming)", async () => {
    scenario = "s1"
    const text = await postStream()
    expect(text).toBe(S1_GOLDEN)
    // No leak of the suppressed server_tool_use / its input.
    expect(text).not.toContain("server_tool_use")
    expect(text).not.toContain("web_search")
    // Heartbeat isolation (intervalSec=0): no synthetic ping interleaved.
    expect(text).not.toContain('"type":"ping"')
    // Option A: the accumulated (upstream-original) response KEEPS the server_tool_use
    // the forwarded stream filters out — accumulate is on raw, not the rewritten frames.
    expect(lastOutboundContent()).toEqual(S1_OUTBOUND)
  })

  test("S2 tool-input decode buffer/flush + question backfill (streaming)", async () => {
    scenario = "s2"
    const text = await postStream()
    // Byte-lock proves the decode+backfill: the buffered `questions` deltas are
    // replaced by one input_json_delta carrying the structured + backfilled input
    // (the value lives inside a nested JSON string, so it is escaped on the wire —
    // the byte-exact golden is the authoritative check).
    expect(text).toBe(S2_GOLDEN)
    expect(text).not.toContain('"type":"ping"')
  })

  test("S3a recover-tool-call CANDIDATE → COMMIT (streaming)", async () => {
    scenario = "s3a"
    setStateForTests({ recoverToolCallText: true })
    const text = await postStream({ tools: [SEARCH_TOOL] })
    expect(text).toBe(S3A_GOLDEN)
    // The downgraded `<invoke>` text was rebuilt into a tool_use block (never forwarded as text).
    expect(text).not.toContain("<invoke")
    expect(text).toContain(SYNTH_ID)
    expect(text).not.toContain('"type":"ping"')
    // Option A: the accumulated (upstream-original) response KEEPS the downgraded TEXT —
    // recovery is forwarded-only (history 保留上游降级原貌).
    expect(lastOutboundContent()).toEqual(S3A_OUTBOUND)
  })

  test("S3b recover-tool-call ROLLBACK (candidate interrupted)", async () => {
    scenario = "s3b"
    setStateForTests({ recoverToolCallText: true })
    const text = await postStream({ tools: [SEARCH_TOOL] })
    expect(text).toBe(S3B_GOLDEN)
    // Rollback replays the buffered invoke-text verbatim (no synthesized tool_use).
    expect(text).toContain("<invoke")
    expect(text).not.toContain(SYNTH_ID)
    expect(text).not.toContain('"type":"ping"')
  })

  test("S4 recover + decode double flush at stream end", async () => {
    scenario = "s4"
    setStateForTests({ recoverToolCallText: true })
    const text = await postStream({ tools: [SEARCH_TOOL] })
    expect(text).toBe(S4_GOLDEN)
    expect(text).not.toContain('"type":"ping"')
  })

  test("S5 recover × server-tool-filter index-space interaction", async () => {
    scenario = "s5"
    setStateForTests({ recoverToolCallText: true })
    const text = await postStream({ tools: [SEARCH_TOOL] })
    expect(text).toBe(S5_GOLDEN)
    expect(text).not.toContain("server_tool_use")
    expect(text).toContain(SYNTH_ID)
    expect(text).not.toContain('"type":"ping"')
  })

  test("S7 thinking-signature-compat reshape (streaming)", async () => {
    scenario = "s7"
    const text = await postStream()
    // Forwarded: the embedded-signature thinking start becomes empty-thinking start +
    // synthesized signature_delta (both inherit `event: content_block_start`).
    expect(text).toBe(S7_GOLDEN)
    expect(text).toContain('"type":"signature_delta","signature":"SIG-XYZ"')
    expect(text).not.toContain('"type":"ping"')
    // Option A: the accumulated (upstream-original) response keeps the signature on the
    // thinking start (the forwarded stream splits it into a signature_delta).
    expect(lastOutboundContent()).toEqual(S7_OUTBOUND)
  })

  test("S8 recover-refusal: thinking-only refusal → synthesized text + end_turn (streaming)", async () => {
    scenario = "s8"
    setStateForTests({ recoverRefusalText: true })
    const text = await postStream()
    expect(text).toBe(S8_GOLDEN)
    // The empty thinking block is kept verbatim; a synthetic text block is appended.
    expect(text).toContain(REFUSAL_RECOVERY_TEXT)
    expect(text).toContain('"type":"signature_delta","signature":"SIG-REF"')
    // stop_reason rewritten away from refusal.
    expect(text).not.toContain('"refusal"')
    expect(text).not.toContain('"type":"ping"')
    // Option A: history keeps the upstream-original thinking-only refusal (no synth text).
    expect(lastOutboundContent()).toEqual(S8_OUTBOUND)
  })

  test("S8 off (default): refusal passes through byte-identical", async () => {
    scenario = "s8"
    const text = await postStream()
    // No recovery: the refusal delta + empty thinking block reach the client unchanged.
    expect(text).toContain('"stop_reason":"refusal"')
    expect(text).not.toContain(REFUSAL_RECOVERY_TEXT)
  })

  test("S6 non-streaming: server-tool blocks filtered from response", async () => {
    scenario = "s6Filter"
    const json = await postJson()
    expect(json).toEqual({
      id: "msg-ns",
      type: "message",
      role: "assistant",
      model: MODEL,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 6 },
      content: [{ type: "text", text: "after search" }],
    })
  })

  test("S6 non-streaming: tool-input decode + question backfill", async () => {
    scenario = "s6Decode"
    const json = await postJson()
    expect(json).toEqual({
      id: "msg-ns",
      type: "message",
      role: "assistant",
      model: MODEL,
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 6 },
      content: [{ type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: { questions: [{ header: "Deploy?", question: "Deploy?" }] } }],
    })
  })

  test("S6 non-streaming: recover-tool-call text → tool_use", async () => {
    scenario = "s6Recover"
    setStateForTests({ recoverToolCallText: true })
    const json = await postJson({ tools: [SEARCH_TOOL] })
    expect(json).toEqual({
      id: "msg-ns",
      type: "message",
      role: "assistant",
      model: MODEL,
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 6 },
      content: [{ type: "tool_use", id: SYNTH_ID, name: "search", input: { query: "weather" } }],
    })
  })

  test("S6 non-streaming: recover-refusal thinking-only → synthesized text + end_turn", async () => {
    scenario = "s6Refusal"
    setStateForTests({ recoverRefusalText: true })
    const json = await postJson()
    expect(json).toEqual({
      id: "msg-ns",
      type: "message",
      role: "assistant",
      model: MODEL,
      stop_reason: "end_turn",
      stop_details: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 6 },
      content: [
        { type: "thinking", thinking: "", signature: "SIG-REF" },
        { type: "text", text: REFUSAL_RECOVERY_TEXT },
      ],
    })
  })
})

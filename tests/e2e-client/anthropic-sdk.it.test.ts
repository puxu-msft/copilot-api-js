/**
 * client↔proxy SDK e2e (Anthropic) — Tier 1.
 *
 * A REAL `@anthropic-ai/sdk` client drives the REAL proxy over genuine HTTP (in-process
 * `Bun.serve`, ephemeral port), with the GHC upstream shielded via the dedicated
 * `setUpstreamFetchForTests` injection point (NOT `globalThis.fetch` — see serve-in-process.ts).
 *
 * The oracle is CLIENT-OBSERVABLE behavior, not our forwarded bytes: what the SDK assembles
 * (`.finalMessage()` deep-equal), whether it throws (`APIError`), whether it drops a frame — the
 * things a byte-golden can't tell you. `maxRetries:0` + `scriptedUpstream.callCount()` is the
 * no-retry oracle.
 */

import Anthropic, {
  //
  APIError,
  APIUserAbortError,
  BadRequestError,
  RateLimitError,
} from "@anthropic-ai/sdk"
import {
  //
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import OpenAI from "openai"

import {
  //
  DEFAULT_REFUSAL_END_TURN_TEXT,
  DEFAULT_REFUSAL_ERROR_MESSAGE,
  DEFAULT_REFUSAL_ERROR_TYPE,
} from "~/lib/anthropic/recover-refusal"
import {
  //
  setBufferedRetryOverride,
  setModels,
  setStateForTests,
} from "~/lib/state"
import { setUpstreamFetchForTests } from "~/lib/transport/upstream-fetch"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import {
  //
  type InProcessProxy,
  serveInProcess,
} from "./harness/serve-in-process"
import {
  //
  createSseResponse,
  createSseResponseThenError,
  httpErrorResponse,
  jsonResponse,
  sequencedUpstream,
  scriptedUpstream,
} from "./harness/upstream-script"

const MODEL = "claude-sonnet-4.6"

/** An event-named SSE frame (event line = data.type). */
const ev = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
const DONE = "data: [DONE]\n\n"

/** A normal 1-text-block turn: message_start → text block → end_turn. */
function happyTurn(text: string): Array<string> {
  return [
    ev("message_start", {
      type: "message_start",
      message: {
        id: "msg_e2e",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
    ev("message_stop", { type: "message_stop" }),
    DONE,
  ]
}

function stalledPartialTurn(text: string): Response {
  const encoder = new TextEncoder()
  const preBoundary = [
    ev("message_start", {
      type: "message_start",
      message: {
        id: "msg_primary_stalled",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
  ].join("")
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(preBoundary))
        // Intentionally never close: fast-retry must start the secondary before this candidate
        // completes its first semantic block. Loser cancellation owns stream disposal.
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

/** thinking-only refusal: a thinking block (empty text + signature) then stop_reason:refusal. */
function refusalTurn(): Array<string> {
  return [
    ev("message_start", {
      type: "message_start",
      message: {
        id: "msg_ref",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG-REF" } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "refusal", stop_details: { type: "refusal" }, stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    ev("message_stop", { type: "message_stop" }),
    DONE,
  ]
}

describe("client↔proxy SDK e2e (Anthropic, upstream shielded)", () => {
  useIsolatedRuntime()

  let proxy: InProcessProxy
  let client: Anthropic

  beforeAll(() => {
    proxy = serveInProcess()
    client = new Anthropic({ baseURL: proxy.baseURL, apiKey: "test-key", maxRetries: 0 })
  })
  afterAll(() => proxy.close())

  beforeEach(() => {
    setStateForTests({ copilotToken: "tok", accountType: "individual", vsCodeVersion: "1.100.0", responseHeaderTimeout: 0 })
    // setStateForTests MERGES (no reset) — restore the refusal config each test so one scenario's
    // custom template can't leak into another's default-asserting oracle.
    setStateForTests({
      refusalSseRewrite: "error",
      refusalEndTurnText: DEFAULT_REFUSAL_END_TURN_TEXT,
      refusalErrorMessage: DEFAULT_REFUSAL_ERROR_MESSAGE,
      refusalErrorType: DEFAULT_REFUSAL_ERROR_TYPE,
      // reset the opt-in rewrite knobs so a scenario that enables one can't leak into another
      recoverToolCallText: false,
      toolRepairMalformedInput: [],
    })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })
  afterEach(() => setUpstreamFetchForTests(undefined))

  test("smoke: SDK reaches localhost proxy; upstream shielded + called exactly once", async () => {
    // Non-streaming client call → proxy forwards stream:false upstream → JSON body (not SSE).
    const up = scriptedUpstream(() =>
      jsonResponse({
        id: "msg_e2e",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    )
    setUpstreamFetchForTests(up.handler)

    const msg = await client.messages.create({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "hello" }] })

    // client-observable: the SDK assembled a coherent message from OUR forwarded bytes.
    // Non-streaming = proxy passes the upstream JSON verbatim, so content is exactly as sent
    // (no `citations` field — the SDK doesn't synthesize one on the non-streaming path).
    expect(msg.content).toEqual([{ type: "text", text: "hi" }] as never)
    expect(msg.stop_reason).toBe("end_turn")
    // isolation oracle: the proxy really called upstream (shield engaged), exactly once (no retry)
    expect(up.callCount()).toBe(1)
  })

  test("streaming: SDK .finalMessage() assembles a coherent turn (positive control for the oracle)", async () => {
    const up = scriptedUpstream(() => createSseResponse(happyTurn("streamed hi")))
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "hello" }] }).finalMessage()

    // client-observable: the SDK's streaming accumulator built the turn from our forwarded frames.
    // (Empirically, SDK 0.106.0 does NOT synthesize a `citations` field on the assembled text block.)
    expect(final.content).toEqual([{ type: "text", text: "streamed hi" }] as never)
    expect(final.stop_reason).toBe("end_turn")
    expect(up.callCount()).toBe(1)
  })

  // ── refusal recovery (success paths) ──────────────────────────────────────

  test("refusal end_turn: SDK assembles a coherent turn with recovery text + stop_reason end_turn", async () => {
    setStateForTests({ refusalSseRewrite: "end_turn" })
    const up = scriptedUpstream(() => createSseResponse(refusalTurn()))
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()

    // client-observable: the thinking block is kept + a synthetic text block carries the recovery text
    expect(final.stop_reason).toBe("end_turn")
    const text = final.content.find((b) => b.type === "text") as { text?: string } | undefined
    expect(text?.text).toBe(DEFAULT_REFUSAL_END_TURN_TEXT)
  })

  test("refusal empty-string end_turn: SDK assembles thinking + NO text block + end_turn (zero-wrapping)", async () => {
    setStateForTests({ refusalSseRewrite: "end_turn", refusalEndTurnText: "" })
    const up = scriptedUpstream(() => createSseResponse(refusalTurn()))
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()

    expect(final.stop_reason).toBe("end_turn")
    expect(final.content.some((b) => b.type === "text")).toBe(false)
    expect(final.content.some((b) => b.type === "thinking")).toBe(true)
    // NOTE: whether Claude Code's agent-loop STALLS on this thinking-only end_turn is a Tier-2 (CLI) question.
  })

  // ── error paths (throws APIError) ─────────────────────────────────────────

  test("refusal error mode: SDK throws APIError; upstream called exactly once (no retry, maxRetries:0)", async () => {
    setStateForTests({ refusalSseRewrite: "error" })
    const up = scriptedUpstream(() => createSseResponse(refusalTurn()))
    setUpstreamFetchForTests(up.handler)

    const run = client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
    await expect(run).rejects.toBeInstanceOf(APIError)
    expect(up.callCount()).toBe(1)
  })

  test("200 + mid-stream SSE error: SDK throws APIError (does not silently complete)", async () => {
    // proxy forwards a normal opening, then upstream emits an Anthropic `event: error` mid-stream.
    const framesWithError = [
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_err",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      }),
      ev("error", { type: "error", error: { type: "api_error", message: "upstream boom" } }),
    ]
    const up = scriptedUpstream(() => createSseResponse(framesWithError))
    setUpstreamFetchForTests(up.handler)

    const run = client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
    await expect(run).rejects.toBeInstanceOf(APIError)
  })

  test("client abort: aborting the request signal → SDK throws APIUserAbortError (distinct from a server error)", async () => {
    const up = scriptedUpstream(() => createSseResponse(happyTurn("would-be answer")))
    setUpstreamFetchForTests(up.handler)

    // Positive control: WITHOUT abort, the same upstream assembles a coherent turn (proves the harness
    // drives the SDK + the abort — not a broken fixture — is what causes the throw below).
    const ok = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
    expect((ok.content[0] as { text?: string })?.text).toBe("would-be answer")

    // Now: a pre-aborted signal makes the SDK reject with APIUserAbortError — a CLIENT-side cancel,
    // a distinct class from any server APIError (the SDK never surfaces a server response at all).
    const controller = new AbortController()
    controller.abort()
    const run = client.messages
      .stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }, { signal: controller.signal })
      .finalMessage()
    await expect(run).rejects.toBeInstanceOf(APIUserAbortError)
  })

  // ── eventless frame dropped by the SDK SSEDecoder ─────────────────────────

  test("eventless frame: SDK drops a data-only (no `event:` line) content_block_start → block missing", async () => {
    setStateForTests({ refusalSseRewrite: "refusal" }) // pure passthrough: no rewrite re-adds an event line

    // Positive control: the SAME text block WITH an event line IS assembled (proves the harness path).
    const upOk = scriptedUpstream(() => createSseResponse(happyTurn("visible")))
    setUpstreamFetchForTests(upOk.handler)
    const okFinal = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
    expect((okFinal.content[0] as { text?: string })?.text).toBe("visible")

    // Now: the text_delta carrying "ghost" is a DATA-ONLY frame (no `event:` line). The
    // @anthropic-ai/sdk SSEDecoder dispatches on the event NAME, so an event-less frame is DROPPED
    // — the block opens (its start has an event line) but the dropped delta never appends "ghost".
    // (An eventless content_block_START alone is NOT observable: a later event-ful delta re-opens
    // the block; so we drop the CONTENT carrier to make the loss visible.)
    const eventlessDelta = `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ghost" } })}\n\n`
    const eventlessFrames = [
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_evl",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      }),
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      eventlessDelta, // ← no event line → SDK drops this delta → "ghost" never appended
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
      ev("message_stop", { type: "message_stop" }),
      DONE,
    ]
    const upEvl = scriptedUpstream(() => createSseResponse(eventlessFrames))
    setUpstreamFetchForTests(upEvl.handler)
    const evlFinal = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
    // client-observable: the dropped delta's text is LOST — the block is empty, NOT "ghost"
    // (DIFFERS from the positive control; proves the proxy MUST keep event lines — anthropicSseFrame).
    const block0 = evlFinal.content[0] as { type?: string; text?: string } | undefined
    expect(block0?.text ?? "").not.toBe("ghost")
  })

  // ── assembly fidelity (beyond bytes: input deep-equal + signature) ────────

  test("tool_use assembly: SDK .finalMessage() tool_use.input deep-equals the streamed object", async () => {
    setStateForTests({ refusalSseRewrite: "refusal" })
    const toolFrames = [
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_tool",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      }),
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_x", name: "search", input: {} } }),
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"we' } }),
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'ather"}' } }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }),
      ev("message_stop", { type: "message_stop" }),
      DONE,
    ]
    const up = scriptedUpstream(() => createSseResponse(toolFrames))
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
    const tool = final.content.find((b) => b.type === "tool_use") as { input?: unknown } | undefined
    // beyond bytes: the SDK spliced partial_json fragments + JSON.parsed them
    expect(tool?.input).toEqual({ query: "weather" })
  })

  test("thinking assembly: SDK accumulates the thinking block with its signature intact", async () => {
    setStateForTests({ refusalSseRewrite: "refusal" })
    const thinkingFrames = [
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_th",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      }),
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me think" } }),
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG-XYZ" } }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } }),
      ev("content_block_stop", { type: "content_block_stop", index: 1 }),
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
      ev("message_stop", { type: "message_stop" }),
      DONE,
    ]
    const up = scriptedUpstream(() => createSseResponse(thinkingFrames))
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
    const thinking = final.content.find((b) => b.type === "thinking") as { thinking?: string; signature?: string } | undefined
    expect(thinking?.thinking).toBe("let me think")
    expect(thinking?.signature).toBe("SIG-XYZ") // signature_delta accumulated intact
  })

  // ── stream truncation (missing terminator) → SDK throws, not a silent partial ──

  test("truncation: upstream clean-EOF without message_stop → SDK throws (proxy synthesizes error frame)", async () => {
    // Positive control lives in the streaming baseline (a complete stream assembles). Here the
    // upstream forwards a partial then EOFs with NO content_block_stop / message_delta / message_stop.
    // The proxy's truncation gate (acc.sawMessageStop === false) fails the request + writes a
    // synthetic error frame, so the client throws instead of silently accepting a truncated turn
    // (the original incident: CC reported "Stream ended without receiving any events").
    const truncated = [
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_tr",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      }),
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }),
      DONE, // ← clean EOF, no content_block_stop / message_delta / message_stop
    ]
    const up = scriptedUpstream(() => createSseResponse(truncated))
    setUpstreamFetchForTests(up.handler)

    const run = client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
    await expect(run).rejects.toBeInstanceOf(APIError)
  })

  // ── HTTP-4xx vs 200+in-stream error: typed subclass + .status (CONTRAST with the 200 case) ──

  test("HTTP-400 upstream → SDK throws a TYPED BadRequestError with .status===400 (contrast: 200+SSE-error is untyped)", async () => {
    // A non-streaming client call that gets an HTTP 400 from upstream. Unlike a 200 + in-stream
    // `event: error` (untyped APIError, .status===undefined — asserted above), an HTTP-response error
    // gives the SDK a TYPED subclass (BadRequestError) with a real `.status`. The proxy forwards a
    // generic 400 (not matching any reactive-retry pattern) as an HTTP error to the client.
    const up = scriptedUpstream(() => httpErrorResponse(400, { type: "invalid_request_error", message: "generic bad request (e2e)" }))
    setUpstreamFetchForTests(up.handler)

    const run = client.messages.create({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] })
    const err = await run.then(() => undefined).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BadRequestError) // the TYPED 400 subclass (a subclass of APIError), not a bare APIError
    expect((err as { status?: number }).status).toBe(400) // typed HTTP path sets .status (unlike in-stream error)
  })

  test("HTTP-429 upstream → SDK throws a TYPED RateLimitError with .status===429 (contrast: 200+SSE-error is untyped)", async () => {
    // The 429 variant of the typed-vs-untyped contrast. An HTTP-response 429 gives the SDK a TYPED
    // subclass (RateLimitError, a distinct class from BadRequestError) with a real `.status===429` —
    // whereas a 200 + in-stream `event: error` yields an untyped APIError with `.status===undefined`
    // (asserted above). This is why CC's retry policy diverges on the two 429 forms (Tier2 territory):
    // the typed HTTP-429 is a first-class rate-limit signal, the in-stream one isn't.
    const up = scriptedUpstream(() => httpErrorResponse(429, { type: "rate_limit_error", message: "rate limited (e2e)" }))
    setUpstreamFetchForTests(up.handler)

    const run = client.messages.create({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] })
    const err = await run.then(() => undefined).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitError) // typed subclass, NOT a bare APIError
    expect((err as { status?: number }).status).toBe(429)
  })

  // ── keepalive/anchor empty deltas: SDK accumulates them harmlessly (B1 Tier1 half) ──

  test("empty content deltas: SDK folds empty text/thinking deltas into the turn without phantom content or crash", async () => {
    // The proxy's keepalive path emits empty content_block_deltas (`text_delta{text:""}` /
    // `thinking_delta{thinking:""}`) to hold the CC 300s no-real-content wall open. This Tier1 half
    // asserts the client-side invariant that makes that safe: a REAL SDK folds those empty deltas into
    // the same block as no-ops — the assembled turn carries ONLY the real visible text, no phantom
    // empty block, no throw. (The 300s wall itself is a Tier2 timing question — see B1 upper half.)
    setStateForTests({ refusalSseRewrite: "refusal" }) // pure passthrough — no rewrite injects frames
    const framesWithEmptyDeltas = [
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_ka",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      }),
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }), // empty keepalive delta
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "real " } }),
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }), // empty keepalive delta
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } }),
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }), // empty keepalive delta
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
      ev("message_stop", { type: "message_stop" }),
      DONE,
    ]
    const up = scriptedUpstream(() => createSseResponse(framesWithEmptyDeltas))
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()

    // client-observable: exactly one text block carrying only the REAL text; empty deltas contributed
    // nothing visible and did not spawn a phantom block or throw.
    expect(final.content.length).toBe(1)
    expect((final.content[0] as { type?: string; text?: string })?.type).toBe("text")
    expect((final.content[0] as { text?: string })?.text).toBe("real answer")
    expect(final.stop_reason).toBe("end_turn")
  })

  test("anchor wire shape: SDK tolerates an empty-text anchor block@0 coexisting with the real block@1 (known-benign)", async () => {
    // The keepalive anchor path (spec 2026-07-08-buffered-keepalive-empty-text-anchor) can inject a
    // SEPARATE empty-text anchor block@0 to reset CC's 300s watchdog, with the real content remapped to
    // block@1, then closes the anchor with content_block_stop@0. The proxy relies on "empty-text block →
    // known-benign" (§3.6). The idle-heartbeat INJECTION itself is timing-driven (Tier2/fake-clock), but
    // the SDK-safety of the WIRE it produces is a deterministic client-observable question: feed that
    // exact shape and confirm a real SDK assembles the real text and does NOT choke on the extra
    // empty anchor block. (Distinct from B1: that was empty deltas within ONE block; here it's a
    // standalone empty anchor block beside the real one.)
    setStateForTests({ refusalSseRewrite: "refusal" }) // pure passthrough — forward the anchor wire as-is
    const anchorWire = [
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_a",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      }),
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), // anchor@0
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }), // empty keepalive delta
      ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }), // real@1 (remapped +1)
      ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "real answer" } }),
      ev("content_block_stop", { type: "content_block_stop", index: 1 }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }), // anchor closed at commit
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
      ev("message_stop", { type: "message_stop" }),
      DONE,
    ]
    const up = scriptedUpstream(() => createSseResponse(anchorWire))
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
    // client-observable, empirically confirmed: the SDK TOLERATES the anchor wire (no throw) and
    // assembles the real text intact at block@1 — but it DOES surface the empty anchor block@0 as a
    // visible (empty) text block. "known-benign" (§3.6) means protocol-safe, NOT invisible: the client
    // receives an extra empty text block, an accepted tradeoff (empty text is harmless to render).
    expect(final.content.length).toBe(2)
    expect(final.content.every((b) => b.type === "text")).toBe(true)
    expect((final.content[0] as { text?: string })?.text).toBe("") // the empty anchor block, surfaced not folded
    expect((final.content[1] as { text?: string })?.text).toBe("real answer") // real content intact past the anchor
    expect(final.stop_reason).toBe("end_turn")
  })

  // ── event-name tolerance: SDK dispatches on the event name ∈ accept-set, not name===data.type ──

  test("thinking-signature-compat: signature_delta under `event: content_block_start` is still accumulated by the SDK", async () => {
    // The SDK's SSEDecoder dispatches on the `event:` NAME (must be in its accept-set), then
    // re-derives behavior from the parsed data.type — so `event` need NOT equal `type`. A
    // signature_delta emitted under `event: content_block_start` (a benign shape the proxy's
    // thinking-signature-compat can produce) is accepted + accumulated, proving the tolerant boundary
    // of the event-line invariant.
    const frames = [
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_sc",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      }),
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
      // signature_delta carried under the WRONG event name (content_block_start, not content_block_delta):
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG-COMPAT" } })}\n\n`,
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
      ev("message_stop", { type: "message_stop" }),
      DONE,
    ]
    const up = scriptedUpstream(() => createSseResponse(frames))
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
    const thinking = final.content.find((b) => b.type === "thinking") as { signature?: string } | undefined
    expect(thinking?.signature).toBe("SIG-COMPAT") // accepted despite event!==type (event ∈ accept-set)
  })

  test("fast-retry: stalled primary partial block is hidden; secondary complete block becomes one coherent SDK message", async () => {
    setStateForTests({
      responseHeaderTimeout: 1,
      generationHedgeEnabled: true,
      generationHedgeThresholdSec: 0,
      protectStreamingGeneration: false,
    })
    const up = sequencedUpstream([() => stalledPartialTurn("PRIMARY-HALF-MUST-NOT-LEAK"), () => createSseResponse(happyTurn("secondary complete"))])
    setUpstreamFetchForTests(up.handler)

    const stream = client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "hedge" }] })
    const final = await stream.finalMessage()

    expect(final.content).toEqual([{ type: "text", text: "secondary complete" }] as never)
    expect(JSON.stringify(final.content)).not.toContain("PRIMARY-HALF-MUST-NOT-LEAK")
    expect(final.stop_reason).toBe("end_turn")
    expect(up.callCount()).toBe(2)
  })
})

// ── vendor-neutral proof: a DIFFERENT real client SDK (OpenAI) against the same proxy ──

describe("client↔proxy SDK e2e (OpenAI vendor, upstream shielded)", () => {
  useIsolatedRuntime()

  const CC_MODEL = "gpt-5.5"
  let proxy: InProcessProxy
  let client: OpenAI

  beforeAll(() => {
    proxy = serveInProcess()
    client = new OpenAI({ baseURL: proxy.baseURL, apiKey: "test-key", maxRetries: 0 })
  })
  afterAll(() => proxy.close())

  beforeEach(() => {
    setStateForTests({ copilotToken: "tok", accountType: "individual", vsCodeVersion: "1.100.0", responseHeaderTimeout: 0 })
    setModels({ object: "list", data: [mockModel(CC_MODEL, { vendor: "OpenAI", supported_endpoints: ["/chat/completions"] })] })
  })
  afterEach(() => setUpstreamFetchForTests(undefined))

  // A minimal CC (OpenAI chat.completion.chunk) streaming upstream — data-only frames, no event line.
  function ccChunks(text: string): Array<string> {
    const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
      `data: ${JSON.stringify({ id: "cc1", object: "chat.completion.chunk", created: 1, model: CC_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    return [chunk({ role: "assistant", content: "" }, null), chunk({ content: text }, null), chunk({}, "stop"), DONE]
  }

  test("smoke: real OpenAI SDK assembles a streamed chat.completion from the same proxy (vendor-neutral core)", async () => {
    const up = scriptedUpstream(() => createSseResponse(ccChunks("hello from openai")))
    setUpstreamFetchForTests(up.handler)

    const stream = await client.chat.completions.create({ model: CC_MODEL, messages: [{ role: "user", content: "hi" }], stream: true })
    let content = ""
    for await (const part of stream) content += part.choices[0]?.delta?.content ?? ""

    // client-observable: the OpenAI SDK decoded + assembled OUR forwarded CC chunks
    expect(content).toBe("hello from openai")
    expect(up.callCount()).toBe(1)
  })

  // ── P3 buffered-retry: mid-stream upstream RST is retried transparently (no half-turn leak) ──
  //
  // Mirrors the Anthropic B16 scenario above (anthropic-sdk.it.test.ts "buffered-retry (upstream
  // RST mid-stream)") but through the REAL `openai` SDK's Chat Completions streaming path, against
  // the P3 chat_completions buffered-retry sink (`driver.runResponseBufferedSink`, commit predicate
  // = terminal-only `ccCommitBoundaries` — CC has no mid-stream block boundary, so ANY truncation
  // before `finish_reason` is pre-commit and fully retryable).
  test("P3 buffered-retry (CC upstream RST mid-stream): first attempt streams a partial delta then RSTs → proxy retries → real OpenAI SDK sees ONE complete turn, the half NOT leaked", async () => {
    setStateForTests({ chatCompletionsBufferedRetry: true, streamKeepalivePingSec: 20 })
    // `setStateForTests` MERGES caps but `processOpenAIMessages` calls `applyConfigToState()`
    // unconditionally on every request, which reloads the bundled config.yaml's top-level
    // `buffered_retry.max_retries` and clobbers `state.bufferedRetryShared` — the per-vendor
    // `chat_completions` override map is untouched by that reload, so THIS is the reliable path
    // (see tests/chat-completions/cc-buffered.integration.test.ts:135-141 for the same lesson).
    setBufferedRetryOverride("chat_completions", { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 })

    const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
      `data: ${JSON.stringify({ id: "cc-rst", object: "chat.completion.chunk", created: 1, model: CC_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    // Attempt 1: a partial delta, then the body ERRORS (RST) — no finish_reason, no [DONE].
    const partialThenRst = [chunk({ role: "assistant", content: "" }, null), chunk({ content: "CC-HALF-LEAK" }, null)]
    // Attempt 2 (retry): a full clean turn.
    const cleanTurn = [chunk({ role: "assistant", content: "" }, null), chunk({ content: "recovered after CC retry" }, null), chunk({}, "stop"), DONE]
    const up = sequencedUpstream([() => createSseResponseThenError(partialThenRst, new Error("RST")), () => createSseResponse(cleanTurn)])
    setUpstreamFetchForTests(up.handler)

    const stream = await client.chat.completions.create({ model: CC_MODEL, messages: [{ role: "user", content: "hi" }], stream: true })
    let content = ""
    let finishReason: string | null | undefined
    for await (const part of stream) {
      content += part.choices[0]?.delta?.content ?? ""
      if (part.choices[0]?.finish_reason) finishReason = part.choices[0].finish_reason
    }

    // client-observable: exactly the retried complete turn; the truncated first attempt never surfaced.
    expect(content).toBe("recovered after CC retry")
    expect(finishReason).toBe("stop")
    expect(content).not.toContain("CC-HALF-LEAK") // the half was buffered away, not leaked
    expect(up.callCount()).toBe(2) // proxy retried the RST internally; the client saw one clean turn
  })
})

// ── P2: Responses-HTTP buffered-retry, via the real `openai` SDK Responses streaming API ──

describe("client↔proxy SDK e2e (OpenAI Responses vendor, upstream shielded, P2 buffered-retry)", () => {
  useIsolatedRuntime()

  const RESP_MODEL = "gpt-5"
  let proxy: InProcessProxy
  let client: OpenAI

  beforeAll(() => {
    proxy = serveInProcess()
    client = new OpenAI({ baseURL: proxy.baseURL, apiKey: "test-key", maxRetries: 0 })
  })
  afterAll(() => proxy.close())

  beforeEach(() => {
    setStateForTests({ copilotToken: "tok", accountType: "individual", vsCodeVersion: "1.100.0", responseHeaderTimeout: 0 })
    setModels({ object: "list", data: [mockModel(RESP_MODEL, { vendor: "OpenAI", supported_endpoints: ["/responses"] })] })
  })
  afterEach(() => setUpstreamFetchForTests(undefined))

  const respEvent = (type: string, seq: number, payload: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq, ...payload })}\n\n`

  /** A complete direct-Responses generation: created → a text delta → response.completed. */
  function completeFrames(text: string): Array<string> {
    return [
      respEvent("response.created", 0, { response: { id: "resp_up_2", object: "response", status: "in_progress", model: RESP_MODEL, output: [] } }),
      respEvent("response.output_item.added", 1, { output_index: 0, item: { id: "msg_0", type: "message", role: "assistant", content: [] } }),
      respEvent("response.output_text.delta", 2, { item_id: "msg_0", output_index: 0, content_index: 0, delta: text }),
      respEvent("response.output_item.done", 3, {
        output_index: 0,
        item: { id: "msg_0", type: "message", role: "assistant", content: [{ type: "output_text", text }] },
      }),
      respEvent("response.completed", 4, {
        response: { id: "resp_up_2", object: "response", status: "completed", model: RESP_MODEL, output: [], usage: { input_tokens: 100, output_tokens: 20 } },
      }),
    ]
  }

  // ── P2a: pre-commit RST — nothing committed yet on the first attempt, so it's fully retryable ──

  test("P2 buffered-retry (pre-commit RST): first attempt RSTs BEFORE any output_item.done → proxy retries → real OpenAI SDK sees ONE complete Response, the half NOT leaked", async () => {
    // With responsesBufferedRetry ON, the block-level commit predicate flushes at each
    // output_item.done boundary. Making the first attempt's RST land BEFORE any output_item.done
    // means nothing has been committed to the client yet — the whole attempt is discarded and
    // retried in full (mirrors the Anthropic B16 / CC P3 scenarios: fully retryable pre-commit).
    setStateForTests({ responsesBufferedRetry: true, streamKeepalivePingSec: 20 })
    setBufferedRetryOverride("responses", { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 })

    const partialThenRst = [
      respEvent("response.created", 0, { response: { id: "resp_up_1", object: "response", status: "in_progress", model: RESP_MODEL, output: [] } }),
      respEvent("response.output_item.added", 1, { output_index: 0, item: { id: "msg_pre", type: "message", role: "assistant", content: [] } }),
      respEvent("response.output_text.delta", 2, { item_id: "msg_pre", output_index: 0, content_index: 0, delta: "RESP-HALF-LEAK" }),
      // ← no output_item.done / response.completed: createSseResponseThenError errors the body here (RST)
    ]
    const up = sequencedUpstream([
      () => createSseResponseThenError(partialThenRst, new Error("RST")),
      () => createSseResponse(completeFrames("complete after RST retry")),
    ])
    setUpstreamFetchForTests(up.handler)

    const final = await client.responses.create({ model: RESP_MODEL, input: "hi", stream: true }).then(async (stream) => {
      let assembled = ""
      // Default drop-delta (spec §3) filters output_text.delta off the forwarded wire once the item is
      // closed by output_item.done; the finalized text survives in output_item.done's item.content (and
      // the repaired completed.output). Reconstruct from output_item.done — the delta-free merged shape.
      for await (const event of stream) {
        if (event.type === "response.output_item.done" && event.item?.type === "message") {
          for (const part of event.item.content ?? []) if (part.type === "output_text") assembled += part.text ?? ""
        }
      }
      return assembled
    })

    // client-observable: exactly the retried complete Response; the truncated first attempt never surfaced.
    expect(final).toBe("complete after RST retry")
    expect(final).not.toContain("RESP-HALF-LEAK") // the half was buffered away, not leaked
    expect(up.callCount()).toBe(2) // proxy retried the RST internally; the client saw one clean Response
  })

  // ── P2b: post-commit RST — the honest block-level partial-degrade behavior (empirically observed) ──

  test("P2 buffered-retry (post-commit RST): first output_item.done commits, THEN RST → NOT retried (partial-degrade) — real OpenAI SDK observes the committed block + a stream error, empirically confirmed", async () => {
    // Block-level buffered retry commits at each output_item.done boundary. Once a block has been
    // flushed to the client it can't be un-sent, so a RST AFTER that boundary is NOT retryable —
    // the proxy settles the generation as `partial-degrade`: the committed block stays on the wire
    // and a Responses `error` event terminates the stream (mirrors
    // tests/responses/responses-buffered.it.test.ts "golden: truncation AFTER the first
    // output_item.done commits"). This test empirically confirms what the REAL `openai` SDK does
    // with that wire shape — a committed item + a trailing `event: error` mid-stream.
    setStateForTests({ responsesBufferedRetry: true, streamKeepalivePingSec: 20 })
    setBufferedRetryOverride("responses", { maxRetries: 2, bufferCapBytes: 16_777_216, heartbeatSec: 15 })

    const firstItemCommittedThenRst = [
      respEvent("response.created", 0, { response: { id: "resp_deg", object: "response", status: "in_progress", model: RESP_MODEL, output: [] } }),
      respEvent("response.output_item.added", 1, { output_index: 0, item: { id: "msg_committed", type: "message", role: "assistant", content: [] } }),
      respEvent("response.output_text.delta", 2, { item_id: "msg_committed", output_index: 0, content_index: 0, delta: "COMMITTED-BLOCK" }),
      respEvent("response.output_item.done", 3, {
        output_index: 0,
        item: { id: "msg_committed", type: "message", role: "assistant", content: [{ type: "output_text", text: "COMMITTED-BLOCK" }] },
      }),
      // ← item0 IS committed here; the RST happens after — un-retryable, partial-degrade.
    ]
    const up = sequencedUpstream([() => createSseResponseThenError(firstItemCommittedThenRst, new Error("RST"))])
    setUpstreamFetchForTests(up.handler)

    let assembled = ""
    let thrown: unknown
    try {
      const stream = await client.responses.create({ model: RESP_MODEL, input: "hi", stream: true })
      // Default drop-delta: the committed block's output_text.delta is filtered off the forwarded wire
      // (item closed by output_item.done at the boundary flush); reconstruct from output_item.done.
      for await (const event of stream) {
        if (event.type === "response.output_item.done" && event.item?.type === "message") {
          for (const part of event.item.content ?? []) if (part.type === "output_text") assembled += part.text ?? ""
        }
      }
    } catch (e) {
      thrown = e
    }

    // The committed block DID reach the client (block-level flushed it live before the RST)…
    expect(assembled).toBe("COMMITTED-BLOCK")
    // …and the SDK's iterator throws on the terminating error frame — the SAME untyped-APIError
    // path already proven for the 200+in-stream error case above (no silent "clean completion").
    expect(thrown).toBeInstanceOf(Error)
    // No retry: a block was already committed to the client (can't unsend) → partial-degrade,
    // exactly one upstream exchange.
    expect(up.callCount()).toBe(1)
  })
})

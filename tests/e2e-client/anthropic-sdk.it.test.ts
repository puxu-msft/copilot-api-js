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
  scriptedUpstream,
  sequencedUpstream,
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
    expect(err).toBeInstanceOf(APIError)
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

  // ── reactive retry leg: proxy retries internally, transparent to the client ──

  test("reactive retry (tool-field rejection): first leg 400 → proxy strips field + retries → client sees ONE clean turn, upstream hit twice", async () => {
    // The proxy's tool-field-rejection-retry strategy fires on a 400 whose body matches
    // `tools.N.custom.<field>: Extra inputs are not permitted`, strips the offending field, and
    // retries — invisibly to the client. Oracle: the SDK assembles a normal turn (positive result)
    // AND upstream was hit twice (the retry happened under the hood, client-transparent).
    const up = sequencedUpstream([
      () => httpErrorResponse(400, { type: "invalid_request_error", message: "tools.0.custom.eager_input_streaming: Extra inputs are not permitted" }),
      () => createSseResponse(happyTurn("recovered after retry")),
    ])
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
    expect((final.content[0] as { text?: string })?.text).toBe("recovered after retry")
    expect(up.callCount()).toBe(2) // proxy retried internally; the client never saw the 400
  })

  test("reactive retry (cache_control subfield rejection): first leg 400 → proxy strips subfield + retries → client sees ONE clean turn, upstream hit twice", async () => {
    // The cache-control-subfield-rejection-retry strategy fires on a 400 whose body matches the
    // four-segment `<section>.N.cache_control.<variant>.<field>: Extra inputs are not permitted` shape
    // (disjoint from tool-field's three-segment `tools.N.<field>:` — see strategies.ts ordering). It
    // marks the subfield endpoint-wide, strips it, and retries — invisibly to the client. Oracle: the
    // SDK assembles a normal turn AND upstream was hit twice.
    const up = sequencedUpstream([
      () => httpErrorResponse(400, { type: "invalid_request_error", message: "system.1.cache_control.ephemeral.scope: Extra inputs are not permitted" }),
      () => createSseResponse(happyTurn("recovered after cc-subfield strip")),
    ])
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
    expect((final.content[0] as { text?: string })?.text).toBe("recovered after cc-subfield strip")
    expect(up.callCount()).toBe(2) // proxy retried internally after stripping the rejected subfield
  })

  test("reactive retry (server-tool rejection): first leg 400 'web search not supported' → proxy strips server tool + retries → client sees ONE clean turn, upstream hit twice", async () => {
    // The server-tool-rejection-retry strategy fires on the upstream's OBSERVED web_search rejection
    // message (SERVER_TOOL_REJECTION_TABLE), fixates the `web_search_` type prefix in the negotiation
    // cache, strips it, and retries — invisibly to the client. Oracle: the SDK assembles a normal turn
    // AND upstream was hit twice.
    const up = sequencedUpstream([
      () => httpErrorResponse(400, { type: "invalid_request_error", message: "The use of the web search tool is not supported." }),
      () => createSseResponse(happyTurn("recovered after server-tool strip")),
    ])
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
    expect((final.content[0] as { text?: string })?.text).toBe("recovered after server-tool strip")
    expect(up.callCount()).toBe(2) // proxy retried internally after stripping the rejected server tool
  })

  test("reactive retry (unsupported-beta explicit list): first leg 400 names the beta → proxy fixates + strips it + retries → client sees ONE clean turn, upstream hit twice", async () => {
    // The unsupported-beta-retry strategy's EXPLICIT-list path fires on `unsupported beta header(s): X`
    // (the upstream names the offending token) → it fixates X in the negotiation cache and strips it
    // on a single deterministic retry (unlike the laconic `invalid beta flag` probe path, which needs
    // real outbound betas + getProbeCandidates to iterate). Oracle: the SDK assembles a normal turn
    // AND upstream was hit twice.
    const up = sequencedUpstream([
      () => httpErrorResponse(400, { type: "invalid_request_error", message: "unsupported beta header(s): e2e-only-beta" }),
      () => createSseResponse(happyTurn("recovered after beta strip")),
    ])
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()
    expect((final.content[0] as { text?: string })?.text).toBe("recovered after beta strip")
    expect(up.callCount()).toBe(2) // proxy retried internally after fixating + stripping the named beta
  })

  test("reactive retry (poisoned thinking): first leg 400 'thinking cannot be modified' → proxy strips all thinking + retries → client sees ONE clean turn, upstream hit twice", async () => {
    // GHC rejects an echoed thinking block with `messages.N.content.M.thinking: ... cannot be modified`.
    // The L2 poisoned-thinking-retry strategy (gated on state.stripThinkingOnReject, default true) strips
    // ALL thinking blocks from the outbound payload and retries once. It only fires if the payload has a
    // thinking block to strip (strippedCount===0 → abort) — so the request must carry a prior assistant
    // turn with a thinking block. Oracle: the SDK assembles a normal turn AND upstream was hit twice.
    setStateForTests({ stripThinkingOnReject: true })
    const up = sequencedUpstream([
      () => httpErrorResponse(400, { type: "invalid_request_error", message: "messages.1.content.0.thinking: cannot be modified" }),
      () => createSseResponse(happyTurn("recovered after thinking strip")),
    ])
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages
      .stream({
        model: MODEL,
        max_tokens: 16,
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [
          { role: "user", content: "solve x" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "prior reasoning", signature: "SIG-ECHO" },
              { type: "text", text: "prior answer" },
            ],
          },
          { role: "user", content: "continue" },
        ],
      })
      .finalMessage()
    expect((final.content[0] as { text?: string })?.text).toBe("recovered after thinking strip")
    expect(up.callCount()).toBe(2) // proxy stripped all thinking + retried internally; client never saw the 400
  })

  // ── buffered-retry: mid-stream upstream RST is retried transparently (no half-turn leak) ──

  test("buffered-retry (upstream RST mid-stream): first leg streams a partial then errors → proxy retries → client sees ONE complete turn, the half NOT leaked", async () => {
    // With protect_streaming_generation on, the proxy buffers the generation; if the upstream stream
    // ERRORS mid-turn (a transport RST before message_stop), it retries upstream instead of forwarding
    // the truncated half. Oracle: the SDK assembles the SECOND leg's complete turn, the first leg's
    // partial text is NOT present, and upstream was hit twice. (Deterministic mid-stream error via
    // createSseResponseThenError — no timers, no real backoff sleep.)
    setStateForTests({ protectStreamingGeneration: "on" })
    const partialThenRst = [
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_rst",
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
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "HALF-LEAK" } }),
      // ← no content_block_stop / message_stop: createSseResponseThenError errors the body here (RST)
    ]
    const up = sequencedUpstream([
      () => createSseResponseThenError(partialThenRst, new Error("RST")),
      () => createSseResponse(happyTurn("complete after RST retry")),
    ])
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages.stream({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "x" }] }).finalMessage()

    // client-observable: exactly the retried complete turn; the truncated first leg never surfaced.
    expect((final.content[0] as { text?: string })?.text).toBe("complete after RST retry")
    expect(final.stop_reason).toBe("end_turn")
    expect(JSON.stringify(final.content)).not.toContain("HALF-LEAK") // the half was buffered away, not leaked
    expect(up.callCount()).toBe(2) // proxy retried the RST internally; the client saw one clean turn
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

  // ── proxy rewrites (config-gated): the client sees the RECOVERED shape, not the broken upstream ──

  test("tool-call text recovery: upstream downgrades tool call to `<invoke>` text → proxy rebuilds tool_use → SDK gets a tool_use block", async () => {
    // GHC sometimes emits a tool call as plain `<function_calls><invoke name="search">...` TEXT
    // (stop_reason still tool_use). With recover_tool_call_text on, the proxy rebuilds a real tool_use
    // block. Oracle: the SDK's finalMessage carries a tool_use (input deep-equal) — NOT a text block
    // the client would fail to parse. Positive control: the streaming baseline proves normal text
    // assembles as text; here the SAME text shape becomes a tool_use because recovery is on.
    setStateForTests({ recoverToolCallText: true })
    const invokeText = '<function_calls><invoke name="search"><parameter name="query">weather</parameter></invoke>'
    const frames = [
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_rc",
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
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: invokeText } }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }),
      ev("message_stop", { type: "message_stop" }),
      DONE,
    ]
    const up = scriptedUpstream(() => createSseResponse(frames))
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages
      .stream({
        model: MODEL,
        max_tokens: 16,
        messages: [{ role: "user", content: "search the weather" }],
        tools: [{ name: "search", description: "search the web", input_schema: { type: "object", properties: { query: { type: "string" } } } }],
      })
      .finalMessage()
    const tool = final.content.find((b) => b.type === "tool_use") as { name?: string; input?: unknown } | undefined
    expect(tool?.name).toBe("search")
    expect(tool?.input).toEqual({ query: "weather" })
    // and the raw `<invoke>` text is NOT surfaced as a text block the client would choke on
    expect(final.content.some((b) => b.type === "text" && (b as { text?: string }).text?.includes("<invoke"))).toBe(false)
  })

  test("malformed tool_use input repair: upstream tool_use JSON is broken → proxy repairs → SDK JSON.parses a valid input", async () => {
    // With tool_repair_malformed_input on, the proxy buffers tool_use blocks and, when the accumulated
    // partial_json is invalid, runs layered repair (antml-tag strip + jsonrepair) before forwarding.
    // Oracle: the SDK's tool_use.input deep-equals the intended object — i.e. the client received
    // JSON it could parse, not the broken bytes.
    setStateForTests({ toolRepairMalformedInput: ["tags", "jsonrepair"] })
    const frames = [
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_mr",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      }),
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_mr", name: "search", input: {} } }),
      // malformed: trailing comma + unclosed brace (jsonrepair territory)
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query": "weather",' } }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }),
      ev("message_stop", { type: "message_stop" }),
      DONE,
    ]
    const up = scriptedUpstream(() => createSseResponse(frames))
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages
      .stream({
        model: MODEL,
        max_tokens: 16,
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "search", description: "search the web", input_schema: { type: "object", properties: { query: { type: "string" } } } }],
      })
      .finalMessage()
    const tool = final.content.find((b) => b.type === "tool_use") as { input?: unknown } | undefined
    expect(tool?.input).toEqual({ query: "weather" }) // repaired to valid JSON the SDK could parse
  })

  test("tool-name restore: proxy sanitizes an illegal client tool name outbound → restores it inbound → SDK sees the ORIGINAL name", async () => {
    // With sanitize_tool_names on, a client tool name that violates the target model's charset (the
    // claude class forbids dots, cap 64) is rewritten to a wire-legal name outbound (`my.search.tool`
    // → `my_search_tool`); the upstream echoes the SANITIZED name in its tool_use, and the proxy
    // restores it to the client-ORIGINAL name before forwarding. Oracle: the SDK's finalMessage
    // tool_use.name is the original `my.search.tool`, NOT the wire `my_search_tool` — a client-
    // observable round-trip the byte layer alone can't confirm.
    setStateForTests({ sanitizeToolNames: true })
    const CLIENT_NAME = "my.search.tool" // dots → illegal for the claude class → sanitized
    const WIRE_NAME = "my_search_tool" // deterministic makeValidToolName(CLIENT_NAME): dots → "_"
    const frames = [
      ev("message_start", {
        type: "message_start",
        message: {
          id: "msg_tn",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      }),
      // upstream echoes the SANITIZED wire name (what it received after outbound sanitization)
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_tn", name: WIRE_NAME, input: {} } }),
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } }),
      ev("message_stop", { type: "message_stop" }),
      DONE,
    ]
    const up = scriptedUpstream(() => createSseResponse(frames))
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages
      .stream({
        model: MODEL,
        max_tokens: 16,
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: CLIENT_NAME, description: "search", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
      })
      .finalMessage()
    const tool = final.content.find((b) => b.type === "tool_use") as { name?: string } | undefined
    expect(tool?.name).toBe(CLIENT_NAME) // restored to the client-original name, not the wire name
    expect(tool?.name).not.toBe(WIRE_NAME)
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
})

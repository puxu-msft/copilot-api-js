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

import Anthropic, { APIError } from "@anthropic-ai/sdk"
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
  jsonResponse,
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
})

/**
 * client↔proxy SDK e2e (Anthropic) — Tier 1, block-level buffered-retry ANCHOR COEXISTENCE.
 *
 * Formalizes `exp/block-level-anchor-coexist/` (fixture + stage-1 wire oracle, both already
 * PASSING 20/20) into a durable Tier-1 test. Answers P1 criterion ① from
 * `docs/spec/2026-07-11-block-level-buffered-retry.md` §4.5: does the REAL `@anthropic-ai/sdk`
 * (0.106.0) ACCEPT and correctly ACCUMULATE the "anchor-coexist" wire shape the block-level
 * buffered-retry keepalive path would produce — an empty-text anchor block@0 that stays open the
 * WHOLE stream while real blocks@1/@2 open and close, with inter-block silence filled by
 * `content_block_delta@0` empty `text_delta` keepalives (not a bare ping)?
 *
 * The fixture (`exp/block-level-anchor-coexist/fixture.ts`) is REUSED verbatim — this test does
 * not invent a new wire shape, it feeds the SAME `STEPS`/`toSseBytes` through the real proxy →
 * real SDK path that `probe.ts` proved offline against a bare `Bun.serve` (no proxy in the loop).
 * The probe's own finding (probe.ts:125-127): the SDK's raw `SSEDecoder` only JSON-decodes, so it
 * CANNOT structurally fail on coexistence — the load-bearing check is the ACCUMULATOR
 * (`client.messages.stream().finalMessage()`), which is what this test exercises.
 *
 * SCOPE: criterion ② (does a keepalive reset Claude Code's real 300s idle deadline) is OUT OF
 * SCOPE — the SDK has no 300s clock; that's a Tier-2 CLI/undici property already proven in
 * `exp/cc-keepalive-idle-oracle/REPORT.md` §0. This test does not attempt real-time timing.
 */

import Anthropic from "@anthropic-ai/sdk"
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

import { setModels } from "~/lib/models/cache"
import { setStateForTests } from "~/lib/state"
import { setUpstreamFetchForTests } from "~/lib/transport/upstream-fetch"

import {
  //
  STEPS,
  toSseBytes,
} from "../../exp/block-level-anchor-coexist/fixture"
import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"
import { createSseResponse } from "../helpers/sse"
import {
  //
  type InProcessProxy,
  serveInProcess,
} from "./harness/serve-in-process"
import { scriptedUpstream } from "./harness/upstream-script"

const MODEL = "claude-opus-4.8" // matches the fixture's message_start.model

/** Serialize the fixture's `STEPS` (in order) into the SSE chunk list `createSseResponse` expects,
 *  plus a trailing `[DONE]` sentinel (the gateway convention every other e2e fixture in this
 *  suite appends). */
function fixtureChunks(steps: typeof STEPS = STEPS): Array<string> {
  return [...steps.map((s) => toSseBytes(s.frame)), "data: [DONE]\n\n"]
}

describe("client↔proxy SDK e2e (Anthropic, block-level anchor-coexist wire — P1 criterion ①)", () => {
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
    // pure passthrough: no refusal-recovery/tool-repair rewrite should touch this shape.
    setStateForTests({ refusalSseRewrite: "refusal", recoverToolCallText: false, toolRepairMalformedInput: [] })
    setModels({ object: "list", data: [mockModel(MODEL, { vendor: "Anthropic", supported_endpoints: ["/v1/messages"] })] })
  })
  afterEach(() => setUpstreamFetchForTests(undefined))

  test("criterion ①: SDK .finalMessage() assembles the REAL blocks correctly under anchor@0 coexistence (no throw, no corruption)", async () => {
    const up = scriptedUpstream(() => createSseResponse(fixtureChunks()))
    setUpstreamFetchForTests(up.handler)

    // (1) does NOT throw under coexistence.
    const final = await client.messages.stream({ model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "go" }] }).finalMessage()

    // (2) the REAL blocks are intact and correctly separated — not merged/corrupted by the
    // coexisting open anchor@0. The SDK accumulator is index-indifferent (appends
    // `content_block_start` payloads in ARRIVAL order into a flat `content` array — see
    // node_modules/@anthropic-ai/sdk/src/lib/MessageStream.ts #accumulateMessage
    // `snapshot.content.push`), so the anchor@0 (empty text) becomes `content[0]`, the real
    // tool_use becomes `content[1]`, and the real text becomes `content[2]` — arrival order,
    // not a re-sort by index. This IS the truthful shape the accumulator produces; asserting it
    // exactly (rather than filtering blocks by type) proves the anchor did not corrupt ordering.
    expect(final.content).toHaveLength(3)
    const [anchorBlock, toolBlock, textBlock] = final.content

    // anchor@0: empty text block, forwarded as real content (the accumulator has no notion of
    // "synthetic" — it accepted an ordinary empty text block, exactly as any real one).
    expect(anchorBlock.type).toBe("text")
    expect((anchorBlock as { text?: string }).text).toBe("")

    // real block@1 (tool_use): full input_json_delta accumulation + JSON.parse, unaffected by the
    // coexisting anchor.
    expect(toolBlock.type).toBe("tool_use")
    expect((toolBlock as { name?: string }).name).toBe("Write")
    expect((toolBlock as { input?: unknown }).input).toEqual({ path: "a.ts" })

    // real block@2 (text): correctly separated from the anchor's own empty text — not merged into
    // a single "0"-indexed text block.
    expect(textBlock.type).toBe("text")
    expect((textBlock as { text?: string }).text).toBe("done")

    // (3) stop_reason carried by the fixture's message_delta.
    expect(final.stop_reason).toBe("tool_use")

    // (4) no spurious retry — upstream called exactly once.
    expect(up.callCount()).toBe(1)
  })

  test("positive control: raw SSEDecoder observes anchor@0 open WHILE a real block is open (mirrors probe.ts sawCoexistence)", async () => {
    // Guards against a fixture that silently stopped exercising coexistence (e.g. an edit that
    // accidentally closed the anchor before the real block opened) — this must independently
    // observe TWO blocks open at once, exactly as `exp/block-level-anchor-coexist/probe.ts:139`
    // computes it (probe-computed, not SDK-judged; see that file's comment on why the raw decoder
    // itself cannot structurally fail on this).
    const up = scriptedUpstream(() => createSseResponse(fixtureChunks()))
    setUpstreamFetchForTests(up.handler)

    const resp = await fetch(`${proxy.baseURL}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 64, stream: true, messages: [{ role: "user", content: "go" }] }),
    })
    const text = await resp.text()
    const openIndices = new Set<number>()
    let sawCoexistence = false
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue
      let parsed: { type?: string; index?: number }
      try {
        parsed = JSON.parse(line.slice(6)) as { type?: string; index?: number }
      } catch {
        continue
      }
      if (parsed.type === "content_block_start" && typeof parsed.index === "number") {
        openIndices.add(parsed.index)
        if (openIndices.has(0) && openIndices.size >= 2) sawCoexistence = true
      } else if (parsed.type === "content_block_stop" && typeof parsed.index === "number") {
        openIndices.delete(parsed.index)
      }
    }
    expect(sawCoexistence).toBe(true)
  })

  // ── mutation verification: prove the assembly assertion has teeth ─────────────────────────
  test("MUTATION: if the anchor@0 close is removed (index collision — the anchor never structurally closes, so the real terminal message_stop follows an ambiguous block-0 state), the accumulator NO LONGER produces the clean 3-block shape asserted above", async () => {
    // Construct a deliberately-corrupted variant: drop the terminal `content_block_stop@0` step
    // (index 12 in STEPS, role "anchor_struct", the anchor's terminal close). Under the healthy
    // fixture this closes the anchor SOLELY at the terminal boundary; removing it means the
    // accumulator's `#endRequest` snapshot is taken with block 0 having received no explicit
    // "stop" bookkeeping for the JSON-buf-input finalize path IF it were a tool block — here it's
    // a plain text block so `content_block_stop` triggers no extra JSON.parse, so instead we prove
    // the mutation by corrupting the actually load-bearing bit: an INDEX COLLISION where the
    // second real block re-uses index 0 (the anchor's index) instead of index 2. This is exactly
    // what would happen if the block-stack fix regressed to a single-slot `openBlock` that
    // misassigns the real block's index to the anchor's — the SAME class of bug the oracle in
    // exp/block-level-anchor-coexist/oracle-wire.ts guards against on the PRODUCER side. Here we
    // guard the CONSUMER side: if such a wire were ever produced, does the assembled Message still
    // look "clean"? It must NOT — proving this test is not vacuously green.
    const collidedSteps = STEPS.map((s) => {
      if (s.frame.event !== "content_block_start" || !s.frame.data) return s
      const data = JSON.parse(s.frame.data) as { type: string; index?: number; content_block?: { type?: string } }
      // The second real block (the text block, content_block.type === "text" with non-empty
      // intended content) originally opens at index 2 — collide it onto index 0 (the anchor's).
      if (data.index === 2 && data.content_block?.type === "text") {
        return { ...s, frame: { ...s.frame, data: JSON.stringify({ ...data, index: 0 }) } }
      }
      return s
    })
    // Also collide the matching delta/stop for that same block so the collision is consistent.
    const fullyCollided = collidedSteps.map((s) => {
      if (!s.frame.data) return s
      const data = JSON.parse(s.frame.data) as { type: string; index?: number }
      if (data.index === 2) return { ...s, frame: { ...s.frame, data: JSON.stringify({ ...data, index: 0 }) } }
      return s
    })

    const up = scriptedUpstream(() => createSseResponse(fixtureChunks(fullyCollided)))
    setUpstreamFetchForTests(up.handler)

    const final = await client.messages.stream({ model: MODEL, max_tokens: 64, messages: [{ role: "user", content: "go" }] }).finalMessage()

    // RED signal (empirically confirmed by running this mutation): the accumulator's
    // `content_block_start` ALWAYS `.push()`es a new array slot regardless of `index` — so the
    // array still ends up length 3 (anchor start, tool_use start, colliding text start each get
    // their own pushed slot). But `content_block_delta`/`content_block_stop` route by the frame's
    // literal `index` into the ARRAY POSITION (`content[event.index] = ...`), NOT by which slot
    // that index's `content_block_start` was pushed into. Colliding the second real block's index
    // onto 0 means its delta OVERWRITES array position 0 (the anchor's slot, meant to stay empty)
    // with "done" — while the block genuinely pushed at array position 2 (meant to carry "done")
    // never receives that delta and stays empty. This is a corruption a real coexistence failure
    // would produce, and it's exactly what the healthy-fixture assertions above (position 0 must
    // stay "" — the anchor; position 2 must be "done" — the real text) would catch: they'd fail if
    // this corruption were ever silently introduced upstream in production wiring.
    const anchorSlot = final.content[0] as { type?: string; text?: string }
    const wouldBeRealTextSlot = final.content[2] as { type?: string; text?: string }
    expect(anchorSlot.text).not.toBe("") // the anchor's slot got clobbered by the colliding delta
    expect(wouldBeRealTextSlot.text).not.toBe("done") // the real text's own delta never reached it
  })
})

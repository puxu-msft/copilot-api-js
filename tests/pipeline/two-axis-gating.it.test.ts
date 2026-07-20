/**
 * Phase 1 (translation-matrix) — two-axis rewrite gating (RFC §3.1 / §7.1, FAIL-R + FAIL-P).
 *
 * Asserts the driver's S5 assembly (`assembleResponseRewrites` over the full-format
 * `ALL_RESPONSE_REWRITES` union) selects the leg-correct rewrite册 by the OUTBOUND axis
 * (`targetEndpoint`), NOT the inbound `clientFormat`:
 *   - a `/v1/messages` leg fires the Anthropic wire rewrites REGARDLESS of clientFormat
 *     (proving the axis switch — the reverse-leg shape cc→messages will fire them);
 *   - a `/chat/completions` leg does NOT fire the Anthropic rewrites even when the inbound is
 *     anthropic (the forward anthropic→cc leg — FAIL-R正向: body is CC, must not run the册);
 *   - fixStreamIds still fires only on direct openai-responses/`/responses`.
 *
 * Uses `assembleResponseRewrites` (the exact function the driver calls at S5) as the oracle,
 * so this pins the real assembly, not a reimplementation. `.it` for `state` defaults.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestContext } from "~/lib/context/request"
import type {
  //
  ClientFormat,
  RequestEnvelope,
  UpstreamEndpoint,
} from "~/lib/pipeline/envelope"

import { ALL_RESPONSE_REWRITES } from "~/lib/codec/response-rewrite-registry"
import { ENDPOINT } from "~/lib/models/endpoint"
import { assembleResponseRewrites } from "~/lib/pipeline/rewrite-registry"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

function envFor(clientFormat: ClientFormat, targetEndpoint: UpstreamEndpoint): RequestEnvelope {
  return {
    clientFormat,
    targetEndpoint,
    model: undefined as unknown as RequestEnvelope["model"],
    stream: true,
    body: { model: "m", messages: [] },
    view: {} as RequestEnvelope["view"],
    prepareHints: {},
    ctx: {} as RequestContext,
    with(patch) {
      return { ...this, ...patch } as RequestEnvelope
    },
  } as RequestEnvelope
}

const names = (clientFormat: ClientFormat, targetEndpoint: UpstreamEndpoint): Array<string> =>
  assembleResponseRewrites(envFor(clientFormat, targetEndpoint), ALL_RESPONSE_REWRITES).map((r) => r.name)

describe("Phase 1 — two-axis response-rewrite gating (targetEndpoint, not clientFormat)", () => {
  useIsolatedRuntime()

  test("anthropic-direct (/v1/messages) fires the Anthropic wire rewrites, not fixStreamIds", () => {
    const n = names("anthropic", ENDPOINT.MESSAGES)
    // server-tool-filter is always-on for the messages leg (no state flag) — the stable anchor.
    expect(n).toContain("server-tool-filter")
    expect(n).not.toContain("responses-fix-stream-ids")
  })

  test("REVERSE leg shape (clientFormat openai-cc → /v1/messages) STILL fires the Anthropic rewrites", () => {
    // The proof of the axis switch: the Anthropic wire register is keyed on the OUTBOUND leg, so a
    // non-anthropic inbound routed to /v1/messages (the Phase-5 reverse leg) fires it too.
    expect(names("openai-cc", ENDPOINT.MESSAGES)).toContain("server-tool-filter")
  })

  test("FORWARD leg shape (clientFormat anthropic → /chat/completions) does NOT fire the Anthropic rewrites", () => {
    // FAIL-R正向: an anthropic request translated to the CC wire must NOT run the Anthropic register
    // (the body is CC-shaped). Gating on clientFormat would wrongly fire it; gating on targetEndpoint does not.
    const n = names("anthropic", ENDPOINT.CHAT_COMPLETIONS)
    expect(n).not.toContain("server-tool-filter")
    expect(n).not.toContain("responses-fix-stream-ids")
  })

  test("openai-responses direct (/responses) fires fixStreamIds, not the Anthropic rewrites", () => {
    const n = names("openai-responses", ENDPOINT.RESPONSES)
    expect(n).toContain("responses-fix-stream-ids")
    expect(n).not.toContain("server-tool-filter")
  })

  test("openai-responses fallback (→/chat/completions) fires neither (fixStreamIds is DIRECT-only)", () => {
    const n = names("openai-responses", ENDPOINT.CHAT_COMPLETIONS)
    expect(n).not.toContain("responses-fix-stream-ids")
    expect(n).not.toContain("server-tool-filter")
  })

  test("openai-cc direct (/chat/completions) fires no register today", () => {
    expect(names("openai-cc", ENDPOINT.CHAT_COMPLETIONS)).toEqual([])
  })
})

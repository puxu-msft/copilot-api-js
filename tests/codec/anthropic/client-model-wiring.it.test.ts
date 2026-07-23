/**
 * Wiring regression: the anthropic codec must surface the client's ORIGINAL
 * (pre-resolution) model name as `ctx.clientModel`, distinct from `resolvedModel`,
 * when a `model_mappings` remap applied.
 *
 * The bug this locks: the v4 messages handler passes the already-resolved
 * `wireBody` (`model === resolvedName`) as `raw.body`, so deriving the client name
 * from `incoming.model` collapsed it to `resolvedName` and `ctx.clientModel` was
 * never set — the `[OK]` log line / detail view then showed only the resolved
 * name, dropping the `<client> → <resolved>` remap. The client-original name must
 * instead come from `raw.originalBodyForHistory` (the pre-resolution client body).
 *
 * Truth domain: codec.parse wiring → the emitted RequestContext snapshot fields,
 * exercised through the real context manager (`withCapturingManager`) + the real
 * codec. Display-given-fields is covered separately (log-line / panel / resolver
 * unit tests); this file covers the seam those inject past.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { Model } from "~/lib/models/client"
import type { RawHttpRequest } from "~/lib/pipeline/types"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { createAnthropicCodec } from "~/lib/codec/anthropic/codec"
import { withCapturingManager } from "~/lib/context/manager"
import { ENDPOINT } from "~/lib/models/endpoint"

import { mockModel } from "../../helpers/factories"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"

useIsolatedRuntime()

/**
 * Parse a `/v1/messages` request the way a handler wires it: `body` is the
 * (optionally already-resolved) wire body, `originalBodyForHistory` is the raw
 * client body, `preResolved` supplies the resolved target. Returns the parsed
 * `env.ctx` so tests can read the observability model fields.
 */
function parse(args: { bodyModel: string; originalModel?: string; resolvedName: string }) {
  const selected: Model = mockModel(args.resolvedName, { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES] })
  const codec = createAnthropicCodec({ betaProbe: createBetaProbe(undefined), preprocessInfo: { strippedReadTagCount: 0, dedupedToolCallCount: 0 } })
  const raw = {
    body: { model: args.bodyModel, max_tokens: 128, messages: [{ role: "user", content: "hi" }], stream: false },
    ...(args.originalModel !== undefined && {
      originalBodyForHistory: { model: args.originalModel, max_tokens: 128, messages: [{ role: "user", content: "hi" }], stream: false },
    }),
    preResolved: { name: args.resolvedName, model: selected },
    headers: new Headers(),
    path: "/v1/messages",
    method: "POST",
  } as unknown as RawHttpRequest
  return withCapturingManager(() => codec.parse(raw)).result.ctx
}

describe("anthropic codec — clientModel wiring", () => {
  test("surfaces the original client name on a remap even when raw.body is pre-resolved (handler shape)", () => {
    // Handler shape: body.model is ALREADY the resolved name; the original lives in originalBodyForHistory.
    const ctx = parse({ bodyModel: "claude-sonnet-5", originalModel: "sonnet", resolvedName: "claude-sonnet-5" })
    expect(ctx.clientModel).toBe("sonnet")
    expect(ctx.resolvedModel).toBe("claude-sonnet-5")
  })

  test("leaves clientModel unset when the client name equals the resolved name (no remap)", () => {
    const ctx = parse({ bodyModel: "claude-x", originalModel: "claude-x", resolvedName: "claude-x" })
    expect(ctx.clientModel).toBeNull()
    expect(ctx.resolvedModel).toBe("claude-x")
  })

  test("surfaces the original name on the client-raw-body shape too (cc/responses parity)", () => {
    // cc/responses pass the unresolved client body as raw.body; no originalBodyForHistory.
    const ctx = parse({ bodyModel: "sonnet", resolvedName: "claude-sonnet-5" })
    expect(ctx.clientModel).toBe("sonnet")
    expect(ctx.resolvedModel).toBe("claude-sonnet-5")
  })

  test("the persisted history entry preserves the raw client model as `requested` (independent oracle)", () => {
    // Assert the PERSISTED product, not just the live ctx fields: even on the
    // pre-resolved handler shape, history's `requested` + `clientRequest.model`
    // must be the raw client name — this falsifies "display fixed but history
    // still dropped the original". Reads a source (originalRequest.model) distinct
    // from resolveCodecModel's return value.
    const ctx = parse({ bodyModel: "claude-sonnet-5", originalModel: "sonnet", resolvedName: "claude-sonnet-5" })
    const entry = ctx.toHistoryEntry()
    expect(entry.model?.requested).toBe("sonnet")
    expect(entry.model?.resolved).toBe("claude-sonnet-5")
    expect(entry.clientRequest?.model).toBe("sonnet")
    expect((entry.clientRequest?.body as { model?: string } | undefined)?.model).toBe("sonnet")
  })
})

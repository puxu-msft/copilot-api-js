/**
 * Wiring regression: the gemini codec must surface the client's ORIGINAL model
 * name — which for Gemini comes from the URL path (`modelId`), not the native
 * `contents[]` body — as `ctx.clientModel` on a genuine remap, and preserve it as
 * the history `requested`.
 *
 * Complements `tests/codec/model-resolution.unit.test.ts` (primitive level) with a
 * codec-level lock: the gemini codec passes `{ requestedModel: modelId }` into the
 * shared primitive, so a URL alias that maps to a different model must round-trip
 * to `ctx.clientModel` (and history `requested`), while a spelling variant / no
 * remap must not set `ctx.clientModel`.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RawHttpRequest } from "~/lib/pipeline/types"

import { createGeminiCodec } from "~/lib/codec/gemini/codec"
import { withCapturingManager } from "~/lib/context/manager"
import { ENDPOINT } from "~/lib/models/endpoint"

import { mockModel } from "../../helpers/factories"
import { useIsolatedRuntime } from "../../helpers/isolated-fixture"

useIsolatedRuntime()

/** Parse a native Gemini request: `modelId` is the URL model, `raw.body` is the native contents[] (no model field). */
function parse(args: { urlModel: string; resolvedName: string }) {
  const selected = mockModel(args.resolvedName, { vendor: "Google", supported_endpoints: [ENDPOINT.CHAT_COMPLETIONS] })
  const codec = createGeminiCodec(args.urlModel)
  const raw = {
    body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    preResolved: { name: args.resolvedName, model: selected },
    headers: new Headers(),
    path: `/v1beta/models/${args.urlModel}:generateContent`,
    method: "POST",
  } as unknown as RawHttpRequest
  return withCapturingManager(() => codec.parse(raw)).result.ctx
}

describe("gemini codec — clientModel wiring", () => {
  test("surfaces the URL-model alias as clientModel + history requested on a remap", () => {
    const ctx = parse({ urlModel: "gemini-pro", resolvedName: "claude-sonnet-5" })
    expect(ctx.clientModel).toBe("gemini-pro")
    expect(ctx.resolvedModel).toBe("claude-sonnet-5")
    const entry = ctx.toHistoryEntry()
    expect(entry.model?.requested).toBe("gemini-pro")
    expect(entry.clientRequest?.model).toBe("gemini-pro")
  })

  test("leaves clientModel unset when the URL model is the resolved model (no remap)", () => {
    const ctx = parse({ urlModel: "claude-sonnet-5", resolvedName: "claude-sonnet-5" })
    expect(ctx.clientModel).toBeNull()
    expect(ctx.resolvedModel).toBe("claude-sonnet-5")
  })
})

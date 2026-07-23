/**
 * Unit coverage for the shared codec model-resolution primitive — the single
 * source of truth all four inbound codecs use to derive
 * {requestedModel, resolvedName, clientModel}. Covers the exact seam the earlier
 * anthropic bug lived at: the client-original name must survive a pre-resolved
 * `body.model`, and the `clientModel` suppression must follow `isSameModelName`
 * (spelling variants suppressed), not a raw `!==`.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { Model } from "~/lib/models/client"
import type { RawHttpRequest } from "~/lib/pipeline/types"

import { resolveCodecModel } from "~/lib/codec/model-resolution"
import { ENDPOINT } from "~/lib/models/endpoint"

import { mockModel } from "../helpers/factories"
import { useIsolatedRuntime } from "../helpers/isolated-fixture"

useIsolatedRuntime()

const selected = (id: string): Model => mockModel(id, { vendor: "Anthropic", supported_endpoints: [ENDPOINT.MESSAGES] })

function raw(args: { bodyModel?: string; originalModel?: string; resolvedName?: string; modelOverride?: string }): RawHttpRequest {
  return {
    body: { model: args.bodyModel, messages: [] },
    ...(args.originalModel !== undefined && { originalBodyForHistory: { model: args.originalModel, messages: [] } }),
    ...(args.resolvedName !== undefined && { preResolved: { name: args.resolvedName, model: selected(args.resolvedName) } }),
    ...(args.modelOverride !== undefined && { modelOverride: args.modelOverride }),
    headers: new Headers(),
  } as unknown as RawHttpRequest
}

describe("resolveCodecModel", () => {
  test("requestedModel survives a pre-resolved body.model (handler shape)", () => {
    // body.model is ALREADY the resolved name; original lives in originalBodyForHistory.
    const r = resolveCodecModel(raw({ bodyModel: "claude-sonnet-5", originalModel: "sonnet", resolvedName: "claude-sonnet-5" }))
    expect(r.requestedModel).toBe("sonnet")
    expect(r.resolvedName).toBe("claude-sonnet-5")
    expect(r.clientModel).toBe("sonnet")
  })

  test("reads the original off the client-raw body when the handler did not pre-resolve (cc/responses shape)", () => {
    const r = resolveCodecModel(raw({ bodyModel: "sonnet", resolvedName: "claude-sonnet-5" }))
    expect(r.requestedModel).toBe("sonnet")
    expect(r.clientModel).toBe("sonnet")
  })

  test("suppresses clientModel for a spelling variant (isSameModelName, not raw !==)", () => {
    const r = resolveCodecModel(raw({ bodyModel: "claude-opus-4-8", resolvedName: "claude-opus-4.8" }))
    expect(r.requestedModel).toBe("claude-opus-4-8")
    expect(r.resolvedName).toBe("claude-opus-4.8")
    expect(r.clientModel).toBeUndefined()
  })

  test("no remap → clientModel undefined, requestedModel still the raw name", () => {
    const r = resolveCodecModel(raw({ bodyModel: "claude-x", resolvedName: "claude-x" }))
    expect(r.requestedModel).toBe("claude-x")
    expect(r.clientModel).toBeUndefined()
  })

  test("explicit requestedModel (gemini URL model) overrides the body", () => {
    const r = resolveCodecModel(raw({ bodyModel: undefined, resolvedName: "claude-sonnet-5" }), { requestedModel: "gemini-pro" })
    expect(r.requestedModel).toBe("gemini-pro")
    expect(r.clientModel).toBe("gemini-pro")
  })

  test("modelOverride (Azure) wins as the requested name", () => {
    const r = resolveCodecModel(raw({ bodyModel: "ignored", resolvedName: "claude-sonnet-5", modelOverride: "azure-deploy" }))
    expect(r.requestedModel).toBe("azure-deploy")
  })

  test("carries the resolved Model object and routeOverride", () => {
    const r = resolveCodecModel(raw({ bodyModel: "sonnet", resolvedName: "claude-sonnet-5" }))
    expect(r.selectedModel?.id).toBe("claude-sonnet-5")
  })
})

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  FrameAction,
  RequestRewrite,
  ResponseRewrite,
  RewriteState,
} from "~/lib/pipeline/rewrite-registry"
import type { UpstreamFrame } from "~/lib/pipeline/types"

import {
  //
  assembleRequestRewrites,
  assembleResponseRewrites,
  BUILTIN_REQUEST_REWRITES,
  BUILTIN_RESPONSE_REWRITES,
} from "~/lib/pipeline/rewrite-registry"

// A minimal envelope stub — the assemblers only read what `appliesTo` reads.
function envWith(clientFormat: string): RequestEnvelope {
  return { clientFormat } as unknown as RequestEnvelope
}

function reqRewrite(name: string, order: number, gate: (env: RequestEnvelope) => boolean): RequestRewrite {
  return {
    name,
    order,
    appliesTo: gate,
    apply: (env) => ({ env, changed: false }),
  }
}

function respRewrite(name: string, order: number, gate: (env: RequestEnvelope) => boolean): ResponseRewrite {
  return {
    name,
    order,
    appliesTo: gate,
    transform: (frame: UpstreamFrame, _state: RewriteState): FrameAction => ({ kind: "emit", frames: [frame] }),
  }
}

describe("assembleRequestRewrites", () => {
  test("filters by appliesTo", () => {
    const registry = [reqRewrite("a", 100, (e) => e.clientFormat === "anthropic"), reqRewrite("b", 200, (e) => e.clientFormat === "openai-cc")]
    const chain = assembleRequestRewrites(envWith("anthropic"), registry)
    expect(chain.map((r) => r.name)).toEqual(["a"])
  })

  test("sorts by order ascending", () => {
    const registry = [reqRewrite("late", 300, () => true), reqRewrite("early", 100, () => true), reqRewrite("mid", 200, () => true)]
    const chain = assembleRequestRewrites(envWith("anthropic"), registry)
    expect(chain.map((r) => r.name)).toEqual(["early", "mid", "late"])
  })

  test("stable order for equal-order ties (registry insertion order preserved)", () => {
    const registry = [reqRewrite("first", 100, () => true), reqRewrite("second", 100, () => true), reqRewrite("third", 100, () => true)]
    const chain = assembleRequestRewrites(envWith("anthropic"), registry)
    expect(chain.map((r) => r.name)).toEqual(["first", "second", "third"])
  })

  test("does not mutate the registry", () => {
    const registry = [reqRewrite("late", 300, () => true), reqRewrite("early", 100, () => true)]
    const before = registry.map((r) => r.name)
    assembleRequestRewrites(envWith("anthropic"), registry)
    expect(registry.map((r) => r.name)).toEqual(before)
  })

  test("encodes the §3 order contract (T < sanitize, A6 < A8, A7 < A8)", () => {
    // Representative order-band entries proving the contract holds after sort.
    const registry = [
      reqRewrite("tool-blocks(A8)", 380, () => true),
      reqRewrite("server-tool-hist(A6)", 350, () => true),
      reqRewrite("補schema(T1)", 100, () => true),
      reqRewrite("thinking-strip(A7)", 360, () => true),
    ]
    const chain = assembleRequestRewrites(envWith("anthropic"), registry).map((r) => r.name)
    expect(chain.indexOf("補schema(T1)")).toBeLessThan(chain.indexOf("server-tool-hist(A6)"))
    expect(chain.indexOf("server-tool-hist(A6)")).toBeLessThan(chain.indexOf("tool-blocks(A8)"))
    expect(chain.indexOf("thinking-strip(A7)")).toBeLessThan(chain.indexOf("tool-blocks(A8)"))
  })

  test("defaults to the module registry (empty in P1.1)", () => {
    expect(BUILTIN_REQUEST_REWRITES).toEqual([])
    expect(assembleRequestRewrites(envWith("anthropic"))).toEqual([])
  })
})

describe("assembleResponseRewrites", () => {
  test("filters by appliesTo and sorts by order", () => {
    const registry = [
      respRewrite("server-tool-filter", 300, (e) => e.clientFormat === "anthropic"),
      respRewrite("thinking-sig", 100, (e) => e.clientFormat === "anthropic"),
      respRewrite("cc-only", 300, (e) => e.clientFormat === "openai-cc"),
    ]
    const chain = assembleResponseRewrites(envWith("anthropic"), registry)
    expect(chain.map((r) => r.name)).toEqual(["thinking-sig", "server-tool-filter"])
  })

  test("defaults to the module registry (empty in P1.1)", () => {
    expect(BUILTIN_RESPONSE_REWRITES).toEqual([])
    expect(assembleResponseRewrites(envWith("anthropic"))).toEqual([])
  })
})

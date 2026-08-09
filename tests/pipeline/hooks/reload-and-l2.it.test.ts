/**
 * Task 5.3 (docs/plan/2026-07-12-upstream-hook-middleware/plan-5-integration-closeout.md) — TWO
 * integration probes that go beyond what Phase 0/4's own tests already cover:
 *
 *  A) RELOAD — `loader.unit.test.ts`'s "data-URL reload" describe already proves the SAME file
 *     path reloads fresh content (calling `loadUpstreamHook` directly, then invoking the returned
 *     function by hand); `hooks.http.test.ts` already proves the `/api/hooks` route surfaces
 *     ok/error + `lastReloadError` (swapping between TWO DIFFERENT fixture files). Neither proves
 *     that reloading the SAME on-disk path via the `/api/hooks/reload` API/state path actually
 *     changes what a REAL DRIVER RUN observes — i.e. that `getUpstreamHook()` (the driver's own
 *     read, `driver.ts`'s `runExchange`) picks up the new module, not a cached one, and that a bad
 *     reload leaves the OLD hook not just "recorded" but still FUNCTIONALLY effective.
 *
 *  B) L2 × exchange interaction (review M1/L1) — the hook mount point sits INSIDE `runExchange`
 *     (S4, per-attempt), which is called both by `runRequest`'s initial exchange AND, again, by
 *     `runResponseBufferedSink`'s (L2) buffered-retry re-exchange. This proves `exchange` fires
 *     exactly once per L1×L2 attempt combination, in strict chronological order — an L1 retry
 *     (a strategy-driven re-exchange) COMPOSED with an L2 retry (a transport-close buffered
 *     re-exchange), not just one or the other in isolation (already covered elsewhere).
 */

import {
  //
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  RetryStrategy,
  RunBufferedOpts,
  Transport,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

import { createRequestContext } from "~/lib/context/request"
import {
  //
  type ApiError,
  HTTPError,
} from "~/lib/error"
import { makeArraySink } from "~/lib/pipeline/client-sink"
import {
  //
  createPipelineDriver,
  type DriverDeps,
} from "~/lib/pipeline/driver"
import {
  //
  getUpstreamHookState,
  resetUpstreamHook,
  setUpstreamHookForTests,
} from "~/lib/pipeline/hooks/loader"
import { setHooksConfig } from "~/lib/state"
import { semanticSseMessage } from "~/lib/transport/parsed-sse-frame"
import { hooksRoutes } from "~/routes/hooks/route"

import { useIsolatedRuntime } from "../../helpers/isolated-fixture"
import {
  //
  BASE,
  makeCodec as makeMockDriverCodec,
  makeCtx,
  makeEnv as makeMockDriverEnv,
} from "./driver-test-helpers"

interface HooksStateBody {
  loadedModule: string | null
  loadedAt: number | null
  version: string | null
  exports: Array<string>
  lastReloadError?: string
}
interface ReloadResponseBody {
  ok: boolean
  error?: string
}

async function reload(): Promise<ReloadResponseBody> {
  const res = await hooksRoutes.request("/reload", { method: "POST" })
  return (await res.json()) as ReloadResponseBody
}
async function hooksState(): Promise<HooksStateBody> {
  const res = await hooksRoutes.request("/")
  return (await res.json()) as HooksStateBody
}

/** A hook whose `exchange` never calls `next()` — it short-circuits with a marker frame, so a
 *  real driver run's rendered output betrays WHICH version (v1/v2) is currently effective. Kept a
 *  self-contained fixture (no imports) for simplicity, though the loader now compiles to a
 *  project-internal file (RFC 2026-07-14 Phase 5) that resolves `~/` aliases + has no data-URL
 *  brace quirks, so imports/nested object literals would be fine too. */
function markerHookSource(marker: string): string {
  return `
export const hooks = {
  exchange: async (_wire: unknown, _env: unknown, _next: unknown) => {
    async function* gen() {
      yield { data: "${marker}" }
    }
    return { frames: gen(), headers: new Headers() }
  },
}
`
}

describe("Task 5.3a — reload via the /api/hooks/reload API/state path, verified by a REAL driver run (not just state bookkeeping)", () => {
  useIsolatedRuntime()

  const tmp = mkdtempSync(join(tmpdir(), "hook-reload-e2e-"))
  const reloadPath = join(tmp, "reload.ts")

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  beforeEach(() => {
    resetUpstreamHook()
  })
  afterEach(() => {
    resetUpstreamHook()
  })

  async function runOnce(): Promise<string> {
    const { ctx } = makeCtx()
    const env = makeMockDriverEnv(ctx)
    const { codec } = makeMockDriverCodec({ env })
    const transport: Transport = {
      send: () => {
        throw new Error("transport.send must never be called — the loaded hook always short-circuits exchange")
      },
    }
    const driver = createPipelineDriver({ ...BASE, codec, decideRoute: (e) => codec.decideRoute(e), transport })
    const result = await driver.runRequest({ body: {}, headers: new Headers() })
    if (!result.ok) throw new Error("expected ok result")
    const frames: Array<UpstreamFrame> = []
    for await (const f of result.upstream.frames) frames.push(semanticSseMessage(f))
    return frames[0]?.data ?? ""
  }

  test("v1 → v2 (same file path, content rewritten) → a real driver run observes v2, never v1", async () => {
    writeFileSync(reloadPath, markerHookSource("v1"))
    setHooksConfig({ hooksEnabled: true, hooksUpstreamModule: reloadPath })
    const r1 = await reload()
    expect(r1.ok).toBe(true)
    const s1 = await hooksState()
    expect(s1.loadedModule).toBe(reloadPath)
    const v1Version = s1.version

    expect(await runOnce()).toBe("v1")

    // Mutate the SAME on-disk path — the data-URL reload mechanism must bypass Bun's
    // path-keyed ESM module cache (docs/memory `reference-bun-esm-cache-busting`).
    writeFileSync(reloadPath, markerHookSource("v2"))
    const r2 = await reload()
    expect(r2.ok).toBe(true)
    const s2 = await hooksState()
    // `version` carries a monotonic sequence suffix (loader.ts's `loadSeq`) in addition to
    // `loadedAt`, so this assertion holds deterministically — not just "usually true because the
    // clock ticked between reloads" (two reloads landing in the same millisecond would otherwise
    // produce an identical `String(loadedAt)` version; see loader.unit.test.ts's dedicated
    // same-millisecond regression test).
    expect(s2.version).not.toBe(v1Version)

    // Independent oracle: NOT just "version changed" — a REAL driver run through
    // `getUpstreamHook()` (the driver's own read seam) sees the NEW behavior.
    expect(await runOnce()).toBe("v2")
  })

  test("a subsequent bad reload (syntax error) keeps the PREVIOUS hook — verified FUNCTIONALLY (a real driver run still observes it), not just via lastReloadError", async () => {
    writeFileSync(reloadPath, markerHookSource("only-good-version"))
    setHooksConfig({ hooksEnabled: true, hooksUpstreamModule: reloadPath })
    await reload()
    expect(await runOnce()).toBe("only-good-version")

    // Overwrite with unparseable content.
    writeFileSync(reloadPath, "export const hooks = ((( not valid typescript")
    const bad = await reload()
    expect(bad.ok).toBe(false)

    const st = await hooksState()
    expect(st.lastReloadError).toBeTruthy()
    // Functional proof (not merely a recorded flag): the driver run STILL executes the old,
    // still-good hook — the singleton was never clobbered by the failed reload attempt.
    expect(await runOnce()).toBe("only-good-version")
    // Cross-check against the singleton directly too.
    expect(getUpstreamHookState()?.exports).toEqual(["exchange"])
  })
})

describe("Task 5.3b — exchange fires once per L1×L2 attempt, across a strategy-driven L1 retry composed with a transport-close L2 retry", () => {
  function f(type: string, extra: Record<string, unknown> = {}): UpstreamFrame {
    return { event: type, data: JSON.stringify({ type, ...extra }) }
  }
  const completeFrames = (): Array<UpstreamFrame> => [f("message_start"), f("content_block_start"), f("content_block_stop"), f("message_stop")]
  const partialFrames = (): Array<UpstreamFrame> => [f("message_start"), f("content_block_start")]

  async function* framesThenThrow(items: Array<UpstreamFrame>, error: Error): AsyncIterable<UpstreamFrame> {
    for (const i of items) yield i
    throw error
  }
  async function* framesClean(items: Array<UpstreamFrame>): AsyncIterable<UpstreamFrame> {
    for (const i of items) yield i
  }
  function upstream(frames: AsyncIterable<UpstreamFrame>): UpstreamStream {
    return { frames, headers: new Headers() }
  }
  const RST = (): Error => new Error("Stream closed with error code NGHTTP2_CANCEL")

  function makeStopTracker() {
    let saw = false
    return {
      onUpstreamFrame: (frame: UpstreamFrame) => {
        try {
          if ((JSON.parse(frame.data ?? "{}") as { type?: string }).type === "message_stop") saw = true
        } catch {
          /* ignore */
        }
      },
      onAttemptReset: () => {
        saw = false
      },
      sawMessageStop: () => saw,
    }
  }

  function makeCodec() {
    return {
      format: "anthropic" as const,
      parse: () => makeEnv(),
      translateOut: (env: RequestEnvelope) => env,
      prepareWire: () => ({ url: "u", headers: new Headers(), body: {}, stream: true }),
      renderResponse: (frame: UpstreamFrame) => frame,
      renderResponseNonStreaming: (u: unknown) => u,
      formatError: () => ({ event: "error", data: "{}" }),
      createResponseAccumulator: () => ({ model: "", inputTokens: 0, outputTokens: 0, rawContent: "" }),
    }
  }

  function makeEnv(): RequestEnvelope {
    const ctx = createRequestContext({ endpoint: "anthropic-messages" })
    return {
      clientFormat: "anthropic",
      targetEndpoint: "/v1/messages",
      model: {},
      stream: true,
      body: {},
      view: {},
      prepareHints: {},
      ctx,
      with(patch: Partial<RequestEnvelope>): RequestEnvelope {
        return { ...this, ...patch } as unknown as RequestEnvelope
      },
    } as unknown as RequestEnvelope
  }

  beforeEach(() => {
    resetUpstreamHook()
  })
  afterEach(() => {
    resetUpstreamHook()
  })

  test("group 1 (L1 retry then L2-triggering RST) + group 2 (clean success) → exchange fires exactly 3 times, strictly in order, and never before the retry it belongs to is reached", async () => {
    const calls: Array<number> = []
    let callIndex = 0
    setUpstreamHookForTests({
      exchange: async (_wire, _env, next) => {
        callIndex++
        calls.push(callIndex)
        // Call #1 (group 1, L1 attempt 1): simulate a transient 500 the "retry-500" strategy
        // handles — never reaches transport (matches a real exchange-thrown error, driver.ts's
        // `runExchange` catch branch).
        if (callIndex === 1) throw new HTTPError("upstream hiccup", 500, "boom")
        // Every other call forwards to the real transport.
        return next()
      },
    })

    let transportCalls = 0
    const transport: Transport = {
      send: async () => {
        transportCalls++
        // Call #2 (group 1, L1 attempt 2 — the retry): a mid-stream RST (truncation, no
        // message_stop) → L2 buffered-retry re-exchanges.
        if (transportCalls === 1) return upstream(framesThenThrow(partialFrames(), RST()))
        // Call #3 (group 2, L1 attempt 1): a clean complete generation.
        return upstream(framesClean(completeFrames()))
      },
    }

    const retry500: RetryStrategy = {
      name: "retry-500",
      canHandle: (e: ApiError) => e.status === 500,
      handle: async (_e, env) => ({ kind: "retry", env }),
    }
    const deps: DriverDeps = {
      codec: makeCodec(),
      transport,
      strategies: [retry500],
      maxRetries: 3,
      maxLearningRetries: 32,
      decideRoute: () => ({ kind: "passthrough", endpoint: "/v1/messages" }),
    }
    const driver = createPipelineDriver(deps)

    const initial = await driver.runRequest({ body: {}, headers: new Headers() })
    expect(initial.ok).toBe(true)
    if (!initial.ok) return

    const { sink } = makeArraySink()
    const tracker = makeStopTracker()
    const outcome = await driver.runResponseBufferedSink(initial.upstream, initial.env, sink, { ...tracker, retryCap: 1 } as RunBufferedOpts)

    expect(outcome.kind).toBe("complete")
    // Exactly 3 exchange invocations: L1-attempt-1 (throws, group 1) + L1-attempt-2 (RST,
    // group 1, the retry the 500-strategy produced) + L1-attempt-1-of-group-2 (clean success).
    expect(calls).toEqual([1, 2, 3])
    expect(transportCalls).toBe(2) // call #1 never reached transport (it threw inside exchange itself)
  })
})

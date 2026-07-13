/**
 * Task 1.0 (docs/plan/2026-07-12-upstream-hook-middleware/plan-1-driver-hookpoints.md) —
 * golden byte-equivalence oracle, captured BEFORE Task 1.1-1.3 touch `driver.ts`.
 *
 * The upstream-hook-middleware's single highest-risk invariant: when no hook module is
 * loaded (`getUpstreamHook() === undefined`), the driver's output must be byte-for-byte
 * identical to pre-hook master. Every subsequent Task (1.1 onRequest / 1.2 onExchange /
 * 1.3 rewriteUpstreamFrame / 2.2 origin tagging) inserts an `if (getUpstreamHook()?.X)`
 * guard around new behavior — this test never mounts a hook, so it must keep passing
 * completely unmodified across every one of those commits. A failure here means an
 * "unconfigured" guard leaked observable behavior — STOP and fix the guard, don't touch
 * this golden.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ClientFrame,
  UpstreamFrame,
} from "~/lib/pipeline/types"

import { createPipelineDriver } from "~/lib/pipeline/driver"
import {
  //
  getUpstreamHook,
  resetUpstreamHook,
} from "~/lib/pipeline/hooks/loader"

import {
  //
  BASE,
  makeCodec,
  makeCtx,
  makeEnv,
  makeTransport,
  okStream,
} from "./driver-test-helpers"

// Representative streaming shapes: an SSE frame with an explicit `event` line, a plain
// data-only frame, an empty-data "keepalive" shape (no event, falsy data), and the
// gateway `[DONE]` transport sentinel (rendered/yielded, only excluded from upstream
// sampling) — the same frame shapes `driver.unit.test.ts`'s own suite already exercises.
const REPRESENTATIVE_FRAMES: Array<UpstreamFrame> = [
  { event: "message_start", data: '{"type":"message_start"}' },
  { event: "content_block_delta", data: '{"type":"content_block_delta","delta":{"text":"hello"}}' },
  { data: "" },
  { event: "message_stop", data: '{"type":"message_stop"}' },
  { data: "[DONE]" },
]

async function collect(it: AsyncIterable<ClientFrame>): Promise<Array<ClientFrame>> {
  const out: Array<ClientFrame> = []
  for await (const f of it) out.push(f)
  return out
}

// Defensive against cross-file singleton pollution (loader.unit.test.ts leaves a hook
// loaded after its last test — module-global `hookState` is process-wide under bun test).
beforeEach(() => {
  resetUpstreamHook()
})
afterEach(() => {
  resetUpstreamHook()
})

describe("hooks — driver passthrough golden (byte equivalence oracle)", () => {
  test("getUpstreamHook() === undefined precondition holds", () => {
    expect(getUpstreamHook()).toBeUndefined()
  })

  test("full runRequest → runResponse round-trip is unchanged when no hook is configured", async () => {
    const { ctx } = makeCtx()
    const env = makeEnv(ctx)
    const { codec } = makeCodec({ env })
    const driver = createPipelineDriver({
      ...BASE,
      codec,
      decideRoute: (e) => codec.decideRoute(e),
      transport: makeTransport(async () => okStream(REPRESENTATIVE_FRAMES)),
    })

    const result = await driver.runRequest({ body: {}, headers: new Headers() })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const out = await collect(driver.runResponse(result.upstream, result.env))

    // GOLDEN — locked against pre-hook master driver.ts. Do not update this literal to
    // "make a later Task's test pass" — a mismatch means the new guard isn't inert.
    expect(out).toEqual(REPRESENTATIVE_FRAMES)
  })
})

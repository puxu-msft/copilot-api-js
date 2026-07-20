/**
 * Barrel resolution test — a hook module imports its whole public surface from
 * `~/lib/pipeline/hooks` (docs/plan/2026-07-12-upstream-hook-middleware, plan-3-helper-toolkit.md
 * Task 3.5). This test only proves every name resolves through the barrel; behavior is already
 * covered by toolkit.unit.test.ts / origin.unit.test.ts / loader.unit.test.ts.
 */
import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  delay,
  getUpstreamHook,
  getUpstreamHookState,
  HOOK_ORIGIN,
  mockAnthropicMessage,
  mockCcChunks,
  mockGeminiResponse,
  mockUpstreamError,
  rawStream,
  readOrigin,
  replayFromHistory,
  resetUpstreamHook,
  setUpstreamHookForTests,
  sse,
  streamOf,
  tagStream,
  truncateAfter,
} from "~/lib/pipeline/hooks"

describe("~/lib/pipeline/hooks barrel", () => {
  test("re-exports the full toolkit + loader public surface + origin tagging primitives", () => {
    for (const fn of [
      sse,
      rawStream,
      streamOf,
      mockAnthropicMessage,
      mockCcChunks,
      mockGeminiResponse,
      mockUpstreamError,
      replayFromHistory,
      delay,
      truncateAfter,
      getUpstreamHook,
      getUpstreamHookState,
      resetUpstreamHook,
      setUpstreamHookForTests,
      tagStream,
      readOrigin,
    ]) {
      expect(typeof fn).toBe("function")
    }
    expect(typeof HOOK_ORIGIN).toBe("symbol")
  })

  test("mockUpstreamError carries its 4 presets through the barrel too", () => {
    expect(typeof mockUpstreamError.toolFieldRejection).toBe("function")
    expect(typeof mockUpstreamError.serverToolRejection).toBe("function")
    expect(typeof mockUpstreamError.cacheControlSubfield).toBe("function")
    expect(typeof mockUpstreamError.unsupportedBeta).toBe("function")
  })
})

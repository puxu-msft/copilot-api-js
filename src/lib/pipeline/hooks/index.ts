/**
 * Barrel — the full public surface a hook module imports from `~/lib/pipeline/hooks`
 * (docs/plan/2026-07-12-upstream-hook-middleware, plan-3-helper-toolkit.md Task 3.5):
 *   - the toolkit (mock/fault-injection/replay helpers, Task 3.1-3.4)
 *   - the loader's public accessors (`getUpstreamHook` etc.) — a hook module itself never calls
 *     these (the loader calls INTO the hook, not the reverse), but they are exposed here for
 *     completeness / test authors who want to introspect hook state from the same import.
 *   - `tagStream`/`readOrigin`/`HOOK_ORIGIN` from `./origin` — re-exported in case a hook author
 *     builds a custom `UpstreamStream` by hand (bypassing `streamOf`/`replayFromHistory`) and still
 *     wants to tag it for history/UI provenance.
 *   - the `UpstreamHook`/`UpstreamHookState` types a hook module's exports are checked against.
 *
 * See README.md (this directory) for the two load-bearing warnings every hook author must know
 * before writing `exchange`/`upstream.inbound`.
 */

export {
  //
  type ClientTurn,
  mapClientMessages,
  stripMessageBlock,
  stripSystemText,
} from "./client-rewrite"
export {
  //
  getUpstreamHook,
  getUpstreamHookState,
  loadUpstreamHook,
  loadUpstreamHookSafe,
  resetUpstreamHook,
  setUpstreamHookForTests,
} from "./loader"
export {
  //
  HOOK_ORIGIN,
  type HookOrigin,
  readOrigin,
  tagFrameRewritten,
  tagStream,
  wasFrameRewritten,
} from "./origin"
export {
  //
  delay,
  mockAnthropicMessage,
  mockCcChunks,
  mockGeminiResponse,
  mockUpstreamError,
  rawStream,
  replayFromHistory,
  sse,
  streamOf,
  truncateAfter,
} from "./toolkit"
export type {
  //
  UpstreamHook,
  UpstreamHookState,
} from "./types"

/**
 * Hook toolkit — the helper set a hook module imports from `~/lib/pipeline/hooks` to mock
 * upstream, inject faults, and replay recorded history (docs/plan/2026-07-12-upstream-hook-middleware,
 * plan-3-helper-toolkit.md).
 */

import type {
  //
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

import { tagStream } from "./origin"

/** Build one SSE frame. `dataObj` is JSON-encoded unless already a string (so a hook author can
 *  pass a raw wire payload like `"[DONE]"` without double-encoding it). */
export function sse(event: string | undefined, dataObj: unknown): UpstreamFrame {
  return { ...(event && { event }), data: typeof dataObj === "string" ? dataObj : JSON.stringify(dataObj) }
}

/** Internal: build an `UpstreamStream` from frames WITHOUT any hook-origin tag. Exposed (not just
 *  module-private) because `replayFromHistory` builds its stream the same way, then tags it
 *  "hook-replay" instead of "hook-mock". */
export function rawStream(frames: Array<UpstreamFrame>, headers = new Headers()): UpstreamStream {
  async function* gen() {
    for (const f of frames) yield f
  }
  return { frames: gen(), headers }
}

/** Public: build a mock `UpstreamStream` tagged "hook-mock" (so the driver's history sink marks
 *  its upstream-original-track frames `synthetic:"hook-mock"` — richest-data-flow: a hook-mock
 *  response must stay distinguishable from a real GHC upstream one). */
export function streamOf(frames: Array<UpstreamFrame>, headers = new Headers()): UpstreamStream {
  return tagStream(rawStream(frames, headers), "hook-mock")
}

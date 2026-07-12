import type {
  //
  ClientFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

export const HOOK_ORIGIN = Symbol("hookOrigin")
export type HookOrigin = "hook-mock" | "hook-replay"

/** Tag an UpstreamStream with its hook origin (read by the driver at sampling to mark history synthetic). */
export function tagStream(s: UpstreamStream, origin: HookOrigin): UpstreamStream {
  return Object.assign(s, { [HOOK_ORIGIN]: origin })
}

/** Read the hook origin off a stream (undefined = real upstream, not hook-produced). */
export function readOrigin(s: UpstreamStream): HookOrigin | undefined {
  return (s as unknown as Record<symbol, unknown>)[HOOK_ORIGIN] as HookOrigin | undefined
}

/**
 * Task 2.3 (docs/plan/2026-07-12-upstream-hook-middleware, plan-2 §Task 2.3): tag a frame
 * `rewriteUpstreamFrame` genuinely changed (returned a DIFFERENT object than the frame it was
 * given) so the sink's forwarded-track sample can mark it `synthetic:"hook-rewrite"`
 * (richest-data-flow — a hook-modified frame the client receives must stay distinguishable
 * from a real upstream one, spec §3.4 decision 2: the mark belongs on the FORWARDED track;
 * the upstream-original track is untouched — it samples pre-hook, per driver.ts:446).
 *
 * A per-FRAME analog of {@link tagStream}/{@link HOOK_ORIGIN} (that one tags a whole stream;
 * this tags one frame object). Implemented as a Symbol-keyed own property so it survives:
 *   - the S5 rewrite-chain passthrough (today's empty `BUILTIN_RESPONSE_REWRITES` returns
 *     frames verbatim; a future no-op rewrite that also returns its input verbatim keeps it
 *     too — `passThrough`'s per-rewrite `transform` only drops the tag if it builds a NEW
 *     frame object instead of re-emitting its input).
 *   - a PASSTHROUGH-leg codec `renderResponse` (Anthropic `/v1/messages`, CC `/chat/completions`,
 *     Responses `/responses` direct all `return frame` verbatim — literally the same object).
 *   - a handler's `onRenderedFrame` reconstruction THAT SPREADS THE INPUT (`{...frame, data:
 *     x}`, e.g. chat-completions' tool-name restore) — object spread copies own Symbol-keyed
 *     properties too (empirically confirmed: `{...src}` and `Object.assign({...src}, patch)`
 *     both carry a Symbol key from `src`), so the tag rides along.
 *
 * It is naturally ABSENT (not corrupted — just unset, so `wasFrameRewritten` reads `false`)
 * wherever a later stage constructs a BRAND-NEW frame object without spreading the input:
 *   - a TRANSLATE-leg codec `renderResponse` (the CC→Anthropic / CC→Responses / CC→Gemini
 *     stream translators are STATEFUL N:1/1:N accumulators over MANY upstream frames — "which
 *     output frame(s) trace to THIS one rewritten input" is genuinely ill-defined there;
 *     docs/spec/2026-07-12-upstream-hook-middleware.md §3.4/§8).
 *   - Responses' `restoreAndAccumulate` (routes/responses/handler-v4.ts) and
 *     `restoreAccumulateCount` (routes/responses/ws.ts), which rebuild a fresh `{event, data}` /
 *     `{data}` literal even on the DIRECT leg (a pre-existing, hook-unrelated reconstruction
 *     pattern that also drops `id`/`retry`) — a documented, separately-tracked gap
 *     (docs/todo/deferred-backlog.md), not something this tagging mechanism can paper over.
 *
 * A hook that MUTATES `frame` in place and returns the SAME reference is also unmarked (there
 * is no way to observe "it changed" without a deep-equality check this module deliberately
 * skips, matching the plan's own "≠ 原 frame" reference-inequality criterion) — hook authors
 * wanting provenance should return a fresh object, mirroring the codebase's other
 * immutable-rewrite conventions (`RequestEnvelope.with`, `ResponseRewrite.transform`).
 */
const FRAME_HOOK_REWRITE = Symbol("frameHookRewrite")

/** Tag a ClientFrame/UpstreamFrame as hook-rewritten (mutates + returns the SAME object). */
export function tagFrameRewritten<T extends ClientFrame>(frame: T): T {
  return Object.assign(frame, { [FRAME_HOOK_REWRITE]: true })
}

/** Read whether a frame carries the hook-rewrite tag (absence ≠ error — see module doc above). */
export function wasFrameRewritten(frame: ClientFrame): boolean {
  return (frame as unknown as Record<symbol, unknown>)[FRAME_HOOK_REWRITE] === true
}

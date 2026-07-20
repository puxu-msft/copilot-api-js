import type { ClientFrame } from "~/lib/pipeline/types"

/**
 * Per-frame synthetic-origin provenance (a pipeline-level primitive).
 *
 * Some frames that reach the FORWARDED (proxy→client) track are not verbatim upstream frames:
 * they were REWRITTEN by a `upstream.inbound` hook, or INJECTED/rewritten by refusal recovery
 * (the synthetic end_turn text block + rewritten delta, or the error-mode `event: error` frame).
 * richest-data-flow (ADR 2026-07-05) §3 requires such synthetic frames stay DISTINGUISHABLE from
 * genuine upstream traffic on the forwarded track (the upstream-original track is sampled pre-rewrite
 * and never carries them). The sink's `write()` reads this tag and marks the forwarded
 * `SseEventRecord.synthetic` accordingly, so history/UI/diagnostics can tell them apart — critical
 * now that the refusal texts are arbitrary/empty config bytes, defeating any content heuristic.
 *
 * Only kinds whose frames flow through the sink's plain `write()` belong here (hook-rewrite +
 * refusal-recovery). Keepalive / anchor / synthetic-message-start are marked via dedicated sink
 * write methods (`writeKeepalive`/`writeAnchor`/…) the driver calls deliberately, not via a frame tag.
 *
 * Implemented as a Symbol-keyed own property so it survives object spreads (`{...frame, data: x}`
 * copies own Symbol keys — empirically confirmed) but is naturally ABSENT (a genuine real frame)
 * wherever a later stage builds a brand-new object without spreading the input. A hook that mutates
 * a frame in place and returns the SAME reference is unmarked by design (no cheap way to observe
 * "it changed") — synthesizers wanting provenance return a fresh (or Object.assign-tagged) object.
 */
const FRAME_SYNTHETIC_ORIGIN = Symbol("frameSyntheticOrigin")

/** Provenance kinds a forwarded-track frame can carry (record-layer metadata only; never affects
 *  the wire bytes sent to the client). */
export type SyntheticOriginKind = "hook-rewrite" | "refusal-recovery" | "error-shaping-auq" | "error-shaping-canonical" | "buffered-terminal-repair"

/** Tag a frame with its synthetic origin (mutates + returns the SAME object — see module doc). */
export function tagFrameSynthetic<T extends ClientFrame>(frame: T, kind: SyntheticOriginKind): T {
  return Object.assign(frame, { [FRAME_SYNTHETIC_ORIGIN]: kind })
}

/** Read a frame's synthetic-origin kind (undefined = a genuine real frame, not synthetic). */
export function readSyntheticKind(frame: ClientFrame): SyntheticOriginKind | undefined {
  return (frame as unknown as Record<symbol, unknown>)[FRAME_SYNTHETIC_ORIGIN] as SyntheticOriginKind | undefined
}

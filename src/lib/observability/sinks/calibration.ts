/**
 * Calibration sink — learns the anthropic-vs-gpt token ratio from SUCCESSFUL
 * `request.completed` events (the 400 leg learns via `CalibrationFailureSink`).
 *
 * For every completed anthropic-messages request it recomputes the local
 * gpt-tokenizer estimate of the wire body with `countTotalInputTokens` — the
 * INPUT-ONLY caliber (excludes prior-turn thinking blocks, matching Anthropic's
 * `usage.input_tokens` semantics) — and pairs it with the upstream's
 * authoritative real input-token count (input + cache_read + cache_creation),
 * feeding the (estimate, real) sample into `learnCalibration` (isLive) so the
 * size-aware per-bucket factor model converges from live traffic — not only
 * from the occasional 400. The 400 leg and the count-tokens consumer use the
 * SAME caliber so all three agree (RFC §3.4).
 *
 * Fire-and-forget observability: the handler NEVER throws (an escaped async
 * rejection would crash the process — skill `debugging-server-crashes`). It
 * returns its promise so the bus can flush it at shutdown / in tests, but any
 * error is swallowed to a debug log.
 */

import consola from "consola"

import type { MessagesPayload } from "~/types/api/anthropic"

import { countTotalInputTokens } from "~/lib/anthropic/token-counting"
import { learnCalibration } from "~/lib/models/calibration"
import { state } from "~/lib/state"

import type {
  //
  ObservabilityBus,
  ObservabilityEvent,
} from "../index"

// Floors below which a sample is too small to teach anything reliable — a tiny
// request's ratio is dominated by fixed overhead / rounding, not the real
// per-size scaling we're trying to learn.
const REAL_FLOOR = 1000
const EST_FLOOR = 500

export class CalibrationSink {
  private readonly unsubscribe: () => void

  constructor(bus: ObservabilityBus) {
    this.unsubscribe = bus.subscribe(
      // Return the promise so the bus tracks it in `inFlight` and `flush()`
      // awaits the learn (deterministic in tests / not lost at shutdown).
      // `handle` has its own try/catch, so it never rejects — fire-and-forget
      // safety is preserved.
      (event) => this.handle(event),
      (event) => event.kind === "request.completed",
      { name: "calibration-sink" },
    )
  }

  destroy(): void {
    this.unsubscribe()
  }

  private async handle(event: ObservabilityEvent): Promise<void> {
    try {
      if (event.kind !== "request.completed") return
      const attempt = event.entry.attempts?.at(-1)
      const req = attempt?.upstreamRequest
      const usage = attempt?.upstreamResponse?.usage
      if (!req || !usage || req.format !== "anthropic-messages") return

      // Upstream's authoritative real input-token count (whole-prompt caliber:
      // fresh input + both cache legs) — the ground truth we calibrate against.
      const real = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      if (real < REAL_FLOOR) return

      const body = req.body as MessagesPayload | undefined
      if (!body?.model) return
      // `req.body.model` is the resolved dotted wire name (e.g. "claude-opus-4.8"),
      // which is exactly the `state.modelIndex` key. The Model (with
      // capabilities.tokenizer) comes from the index — the ctx snapshot only
      // carries `resolvedModel` as a STRING (P-B1).
      const model = state.modelIndex.get(body.model)
      if (!model) return

      const est = await countTotalInputTokens(body, model)
      if (est < EST_FLOOR) return
      learnCalibration(model.id, est, real, { isLive: true })
    } catch (err) {
      // Never throw from a fire-and-forget sink.
      consola.debug("[calibration-sink] skipped", err)
    }
  }
}

export function attachCalibrationSink(bus: ObservabilityBus): () => void {
  const sink = new CalibrationSink(bus)
  return () => {
    sink.destroy()
  }
}

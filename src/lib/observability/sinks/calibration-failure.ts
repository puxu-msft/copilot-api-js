/**
 * Calibration FAILURE sink — the 400-leg counterpart of {@link CalibrationSink}.
 *
 * The success sink learns the anthropic-vs-gpt token ratio from completed
 * requests, but those are always UNDER the model's limit, so it never reaches the
 * highest size buckets. A token-limit 400 carries the upstream's authoritative real
 * count for a prompt that EXCEEDED the limit — a valuable ground truth for the top
 * buckets. This sink observes `request.failed` (statusCode 400), parses the reported
 * real token count from the upstream error body, recomputes the local estimate with
 * the SAME input-only caliber the success sink uses (RFC §3.4), and feeds the pair
 * into `learnCalibration` (isLive).
 *
 * Decoupled from any retry strategy (the reactive truncation path that used to host
 * this — `onTokenLimitExceeded` — was removed with auto-truncate). Fire-and-forget:
 * the handler NEVER throws (an escaped async rejection would crash the process —
 * skill `debugging-server-crashes`).
 */

import consola from "consola"

import type { MessagesPayload } from "~/types/api/anthropic"

import { countTotalInputTokens } from "~/lib/anthropic/token-counting"
import {
  //
  extractTokenLimitFromResponseText,
  parseTokenLimitError,
} from "~/lib/error"
import { learnCalibration } from "~/lib/models/calibration"
import { state } from "~/lib/state"

import type {
  //
  ObservabilityBus,
  ObservabilityEvent,
} from "../index"

export class CalibrationFailureSink {
  private readonly unsubscribe: () => void

  constructor(bus: ObservabilityBus) {
    this.unsubscribe = bus.subscribe(
      // Return the promise so the bus tracks it in `inFlight` and `flush()` awaits
      // the learn (deterministic in tests / not lost at shutdown). `handle` has its
      // own try/catch, so it never rejects — fire-and-forget safety is preserved.
      (event) => this.handle(event),
      (event) => event.kind === "request.failed",
      { name: "calibration-failure-sink" },
    )
  }

  destroy(): void {
    this.unsubscribe()
  }

  private async handle(event: ObservabilityEvent): Promise<void> {
    try {
      if (event.kind !== "request.failed" || event.statusCode !== 400) return
      const attempt = event.entry.attempts?.at(-1)
      const rawBody = attempt?.upstreamResponse?.rawBody
      if (typeof rawBody !== "string") return

      // The upstream 400 body is normally JSON (`{ error: { message } }`); fall back
      // to parsing a bare message string. Only a token-limit 400 yields a value.
      const parsed = extractTokenLimitFromResponseText(rawBody) ?? parseTokenLimitError(rawBody)
      if (!parsed || parsed.current <= 0) return

      const req = attempt?.upstreamRequest
      if (!req || req.format !== "anthropic-messages") return
      const body = req.body as MessagesPayload | undefined
      if (!body?.model) return
      const model = state.modelIndex.get(body.model)
      if (!model) return

      const est = await countTotalInputTokens(body, model)
      if (est <= 0) return
      learnCalibration(model.id, est, parsed.current, { isLive: true })
    } catch (err) {
      // Never throw from a fire-and-forget sink.
      consola.debug("[calibration-failure-sink] skipped", err)
    }
  }
}

export function attachCalibrationFailureSink(bus: ObservabilityBus): () => void {
  const sink = new CalibrationFailureSink(bus)
  return () => {
    sink.destroy()
  }
}

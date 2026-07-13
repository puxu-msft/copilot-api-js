/**
 * Debug API — offline diagnostics that replay real pipeline functions without
 * sending anything upstream.
 *
 * `POST /api/debug/calibration-probe` reports the local token-count calibration for
 * a payload (passed inline or pulled from a stored history entry), short-circuiting
 * any GHC call. It returns the raw gpt-tokenizer estimate, the calibrated estimate
 * (`calibrate()` — the learned size-aware factor applied), the factor at that size,
 * and the model's learned-limits state (live sample count + per-bucket factor model).
 * When replaying a failed history entry it also surfaces the upstream-reported real
 * token count (parsed from the 400 error), making the local-vs-upstream caliber gap
 * directly observable offline.
 */

import {
  //
  createRoute,
  OpenAPIHono,
} from "@hono/zod-openapi"
import { z } from "zod"

import type { Model } from "~/lib/models/client"
import type { MessagesPayload } from "~/types/api/anthropic"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import { countTotalInputTokens } from "~/lib/anthropic/token-counting"
import { parseTokenLimitError } from "~/lib/error"
import { getEntry } from "~/lib/history"
import {
  //
  calibrate,
  factorAt,
  getLearnedLimits,
} from "~/lib/models/calibration"
import { resolveModelName } from "~/lib/models/resolver"
import { getTokenCount } from "~/lib/models/tokenizer"
import { state } from "~/lib/state"

import { handleDryRunPipeline } from "./dry-run-pipeline"

export const debugRoutes = new OpenAPIHono()

// `dry-run-pipeline` keeps a plain `.post` (not `.openapi`): its handler lives in
// a separate module and its output is highly dynamic (per-format × per-stage
// intermediate state), so a faithful schema would be noise. It stays functional
// but is intentionally absent from the OpenAPI document.
debugRoutes.post("/dry-run-pipeline", handleDryRunPipeline)

const CalibrationProbeSchema = z
  .object({
    /** Replay a stored history entry by id (uses its inboundRequest payload). */
    entryId: z.string().min(1).optional(),
    /** Replay an inline payload instead of a stored entry. */
    payload: z.record(z.string(), z.unknown()).optional(),
    /** Format of the inline payload (ignored for entryId, derived from the entry). */
    format: z.enum(["anthropic", "openai"]).optional(),
  })
  .strict()

interface ReportedTokens {
  current: number
  limit: number
}

interface ProbeResolved {
  payload: Record<string, unknown>
  format: "anthropic" | "openai"
  model: Model
  resolvedModel: string
  reported: ReportedTokens | null
}

/** Resolve the probe input into a concrete payload + model, or an error response. */
function resolveInput(body: z.infer<typeof CalibrationProbeSchema>): ProbeResolved | { error: string; status: 400 | 404 } {
  let payload: Record<string, unknown>
  let format: "anthropic" | "openai"
  let reported: ReportedTokens | null = null

  if (body.entryId !== undefined) {
    const entry = getEntry(body.entryId)
    if (!entry) return { error: `History entry not found: ${body.entryId}`, status: 404 }
    const cr = entry.clientRequest
    // Prefer the raw inbound payload (new rows); legacy rows expose only the
    // structured client-request projection (body absent → adapter-filled fields).
    payload = (cr?.body as Record<string, unknown> | undefined) ?? ({ ...cr } as Record<string, unknown>)
    format = entry.endpoint === "anthropic-messages" ? "anthropic" : "openai"
    // The real token counts are only in the upstream error text — input_tokens is 0 for failures.
    const upstreamError = entry.attempts?.at(-1)?.error ?? entry._index?.derived?.failureReason
    reported = upstreamError ? parseTokenLimitError(upstreamError) : null
  } else if (body.payload !== undefined) {
    payload = body.payload
    format = body.format ?? "anthropic"
  } else {
    return { error: "Provide either `entryId` or `payload`", status: 400 }
  }

  const clientModel = typeof payload.model === "string" ? payload.model : undefined
  if (!clientModel) return { error: "Payload is missing a `model` field", status: 400 }

  // The payload is untrusted (inline) or only loosely typed (history entry). The
  // tokenize functions iterate `messages`/`content`/`system`, so a minimal structural
  // guard turns the common malformed-input case into a clean 400 instead of an uncaught
  // TypeError → 500. Deeper block-shape errors are caught at replay time.
  if (!Array.isArray(payload.messages)) return { error: "Payload `messages` must be an array", status: 400 }

  const resolvedModel = resolveModelName(clientModel)
  const model = state.modelIndex.get(resolvedModel)
  if (!model) return { error: `Unknown model: ${clientModel} (resolved: ${resolvedModel})`, status: 400 }

  return { payload, format, model, resolvedModel, reported }
}

const ErrorSchema = z.record(z.string(), z.unknown())

const calibrationProbeRoute = createRoute({
  method: "post",
  path: "/calibration-probe",
  tags: ["debug"],
  summary: "Offline token-count calibration probe (raw vs calibrated + learned state)",
  // Body validated by the handler (CalibrationProbeSchema), not the OpenAPI layer, so its
  // bespoke 400/404 envelopes are preserved.
  description:
    "Body: { entryId } or { payload, format? }. Reports the raw gpt-tokenizer estimate, the calibrated estimate, the learned factor, and the model's learned-limits state.",
  responses: {
    200: { description: "Raw vs calibrated estimate + learned factor model", content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: "Invalid input", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "History entry not found", content: { "application/json": { schema: ErrorSchema } } },
  },
})

debugRoutes.openapi(calibrationProbeRoute, async (c) => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400)
  }

  const parsed = CalibrationProbeSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400)
  }

  const resolved = resolveInput(parsed.data)
  if ("error" in resolved) {
    return c.json({ error: resolved.error }, resolved.status)
  }

  const { payload, format, model, resolvedModel, reported } = resolved

  try {
    // Raw gpt-tokenizer estimate — the INPUT-ONLY caliber the calibration model is
    // trained on (excludes prior-turn thinking, matching upstream `usage.input_tokens`).
    const rawInputTokens =
      format === "anthropic" ?
        await countTotalInputTokens(payload as unknown as MessagesPayload, model)
      : (await getTokenCount(payload as unknown as ChatCompletionsPayload, model)).input

    const factor = factorAt(model.id, rawInputTokens)
    const calibrated = calibrate(model.id, rawInputTokens)

    const learned = getLearnedLimits(model.id)

    return c.json(
      {
        input: {
          mode: parsed.data.entryId !== undefined ? "entry" : "payload",
          ...(parsed.data.entryId !== undefined && { entryId: parsed.data.entryId }),
          format,
          resolvedModel,
        },
        estimate: {
          rawInputTokens,
          factor: Number(factor.toFixed(4)),
          calibrated,
        },
        // Upstream ground truth (entry mode, when the entry failed with a token-limit 400).
        reported,
        ratios: {
          reportedOverRaw: reported && rawInputTokens > 0 ? Number((reported.current / rawInputTokens).toFixed(3)) : null,
          calibratedOverRaw: rawInputTokens > 0 ? Number((calibrated / rawInputTokens).toFixed(3)) : null,
        },
        learned:
          learned ?
            {
              liveSampleCount: learned.liveSampleCount,
              updatedAt: learned.updatedAt,
              buckets: learned.factorModel.buckets,
            }
          : null,
      },
      200,
    )
  } catch (error) {
    // Defense-in-depth: malformed block shapes inside an otherwise array-shaped
    // payload (bad content/system/tool blocks) make the tokenizer iterate a
    // non-iterable and throw. Surface as 400 (bad input) rather than a 500.
    return c.json({ error: `Failed to probe calibration: ${error instanceof Error ? error.message : String(error)}` }, 400)
  }
})

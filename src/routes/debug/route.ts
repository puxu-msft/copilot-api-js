/**
 * Debug API — offline diagnostics that replay real pipeline functions without
 * sending anything upstream.
 *
 * `POST /api/debug/dry-run-truncate` replays the auto-truncate path against a
 * payload (passed inline or pulled from a stored history entry), short-circuiting
 * the GHC call. It returns the three token calibers side-by-side — gpt-tokenizer
 * (what truncate compares against), char/4 (the legacy strategy estimate), and the
 * upstream-reported Anthropic/OpenAI count — plus the pre-check verdict and the
 * real truncation result. This makes the caliber mismatch (gpt ≈ ½ of the
 * upstream-reported count for Claude models) directly observable offline.
 */

import { Hono } from "hono"
import { z } from "zod"

import type { Model } from "~/lib/models/client"
import type { MessagesPayload } from "~/types/api/anthropic"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"

import {
  //
  autoTruncateAnthropic,
  checkNeedsCompactionAnthropic,
  countTotalTokens,
} from "~/lib/anthropic/auto-truncate"
import { parseTokenLimitError } from "~/lib/error"
import { getEntry } from "~/lib/history"
import { resolveModelName } from "~/lib/models/resolver"
import { getTokenCount } from "~/lib/models/tokenizer"
import {
  //
  autoTruncateOpenAI,
  checkNeedsCompactionOpenAI,
} from "~/lib/openai/auto-truncate"
import { state } from "~/lib/state"

export const debugRoutes = new Hono()

const DryRunSchema = z
  .object({
    /** Replay a stored history entry by id (uses its inboundRequest payload). */
    entryId: z.string().min(1).optional(),
    /** Replay an inline payload instead of a stored entry. */
    payload: z.record(z.string(), z.unknown()).optional(),
    /** Format of the inline payload (ignored for entryId, derived from the entry). */
    format: z.enum(["anthropic", "openai"]).optional(),
    /** Explicit gpt-caliber target token limit; when omitted it is derived from the reported limit. */
    target: z.number().positive().nullable().optional(),
  })
  .strict()

interface ReportedTokens {
  current: number
  limit: number
}

interface DryRunResolved {
  payload: Record<string, unknown>
  format: "anthropic" | "openai"
  model: Model
  resolvedModel: string
  reported: ReportedTokens | null
}

/** Resolve the dry-run input into a concrete payload + model, or an error response. */
function resolveInput(body: z.infer<typeof DryRunSchema>): DryRunResolved | { error: string; status: 400 | 404 } {
  let payload: Record<string, unknown>
  let format: "anthropic" | "openai"
  let reported: ReportedTokens | null = null

  if (body.entryId !== undefined) {
    const entry = getEntry(body.entryId)
    if (!entry) return { error: `History entry not found: ${body.entryId}`, status: 404 }
    const ir = entry.inboundRequest
    payload = { ...ir } as Record<string, unknown>
    format = entry.endpoint === "anthropic-messages" ? "anthropic" : "openai"
    // The real token counts are only in the upstream error text — input_tokens is 0 for failures.
    reported = entry.outboundResponse?.error ? parseTokenLimitError(entry.outboundResponse.error) : null
  } else if (body.payload !== undefined) {
    payload = body.payload
    format = body.format ?? "anthropic"
  } else {
    return { error: "Provide either `entryId` or `payload`", status: 400 }
  }

  const clientModel = typeof payload.model === "string" ? payload.model : undefined
  if (!clientModel) return { error: "Payload is missing a `model` field", status: 400 }

  // The payload is untrusted (inline) or only loosely typed (history entry). The
  // tokenize/truncate functions iterate `messages`/`content`/`system`, so a minimal
  // structural guard turns the common malformed-input case into a clean 400 instead
  // of an uncaught TypeError → 500. Deeper block-shape errors are caught at replay time.
  if (!Array.isArray(payload.messages)) return { error: "Payload `messages` must be an array", status: 400 }

  const resolvedModel = resolveModelName(clientModel)
  const model = state.modelIndex.get(resolvedModel)
  if (!model) return { error: `Unknown model: ${clientModel} (resolved: ${resolvedModel})`, status: 400 }

  return { payload, format, model, resolvedModel, reported }
}

debugRoutes.post("/dry-run-truncate", async (c) => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400)
  }

  const parsed = DryRunSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400)
  }

  const resolved = resolveInput(parsed.data)
  if ("error" in resolved) {
    return c.json({ error: resolved.error }, resolved.status)
  }

  const { payload, format, model, resolvedModel, reported } = resolved

  try {
    // Caliber 1: gpt-tokenizer (the caliber truncate compares against internally).
    const gptTokenizer =
      format === "anthropic" ?
        await countTotalTokens(payload as unknown as MessagesPayload, model)
      : (await getTokenCount(payload as unknown as ChatCompletionsPayload, model)).input
    // Caliber 2: the legacy char/4 strategy estimate.
    const charOver4 = Math.ceil(JSON.stringify(payload).length / 4)

    // Derive the gpt-caliber target the strategy would apply (mirrors strategies/auto-truncate.ts).
    let appliedGptTarget = parsed.data.target ?? undefined
    if (appliedGptTarget === undefined && reported?.limit) {
      const reportedTarget = reported.limit * state.autoTruncateTargetFactor
      const ratio = reported.current && reported.current > 0 && gptTokenizer > 0 ? reported.current / gptTokenizer : undefined
      appliedGptTarget = ratio !== undefined ? Math.floor(reportedTarget / ratio) : Math.floor(reportedTarget)
    }

    // Pre-check + real truncation, sharing the same format-specific functions the pipeline uses.
    const truncateOpts = { checkTokenLimit: true, ...(appliedGptTarget !== undefined && { targetTokenLimit: appliedGptTarget }) }

    let preCheck: { needed: boolean; currentTokens: number; tokenLimit: number; reason?: string }
    let truncate: { wasTruncated: boolean; originalTokensGpt: number; compactedTokensGpt: number; removedMessageCount: number; processingTimeMs: number }

    if (format === "anthropic") {
      const p = payload as unknown as MessagesPayload
      const pre = await checkNeedsCompactionAnthropic(p, model, {})
      preCheck = { needed: pre.needed, currentTokens: pre.currentTokens, tokenLimit: pre.tokenLimit, reason: pre.reason }
      const tr = await autoTruncateAnthropic(p, model, truncateOpts)
      const compactedTokensGpt = tr.wasTruncated ? await countTotalTokens(tr.payload, model) : gptTokenizer
      truncate = {
        wasTruncated: tr.wasTruncated,
        originalTokensGpt: gptTokenizer,
        compactedTokensGpt,
        removedMessageCount: tr.removedMessageCount,
        processingTimeMs: tr.processingTimeMs,
      }
    } else {
      const p = payload as unknown as ChatCompletionsPayload
      const pre = await checkNeedsCompactionOpenAI(p, model, {})
      preCheck = { needed: pre.needed, currentTokens: pre.currentTokens, tokenLimit: pre.tokenLimit, reason: pre.reason }
      const tr = await autoTruncateOpenAI(p, model, truncateOpts)
      const compactedTokensGpt = tr.wasTruncated ? (await getTokenCount(tr.payload, model)).input : gptTokenizer
      truncate = {
        wasTruncated: tr.wasTruncated,
        originalTokensGpt: gptTokenizer,
        compactedTokensGpt,
        removedMessageCount: tr.removedMessageCount,
        processingTimeMs: tr.processingTimeMs,
      }
    }

    return c.json({
      input: {
        mode: parsed.data.entryId !== undefined ? "entry" : "payload",
        ...(parsed.data.entryId !== undefined && { entryId: parsed.data.entryId }),
        format,
        resolvedModel,
      },
      calibers: { gptTokenizer, charOver4, reported },
      ratios: {
        reportedOverGpt: reported && gptTokenizer > 0 ? Number((reported.current / gptTokenizer).toFixed(3)) : null,
        charOver4OverGpt: gptTokenizer > 0 ? Number((charOver4 / gptTokenizer).toFixed(3)) : null,
      },
      limit: { effectiveLimit: preCheck.tokenLimit, appliedGptTarget: appliedGptTarget ?? null },
      preCheck,
      truncate,
    })
  } catch (error) {
    // Defense-in-depth: malformed block shapes inside an otherwise array-shaped
    // payload (bad content/system/tool blocks) make the tokenizer/truncate iterate
    // a non-iterable and throw. Surface as 400 (bad input) rather than a 500.
    return c.json({ error: `Failed to replay truncation: ${error instanceof Error ? error.message : String(error)}` }, 400)
  }
})

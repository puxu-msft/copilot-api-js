/**
 * Telemetry dimension EXTRACTORS (sink layer).
 *
 * A dimension is a registered key-extractor over a settled request's `entry` (+ `ctx`, for
 * ctx-derived dimensions). The sink computes the per-dimension keys HERE — where the entry/ctx
 * types are in scope — and hands `request-telemetry.ts` a plain
 * `Record<dimName, key | key[] | null>`, keeping that aggregation leaf type-light (it never
 * imports entry/ctx, only the resolved keys).
 *
 * The other half of the registry — the dimension NAMES + cardinality classes + the
 * {@link ThinkingBlockCounts} measure-input shape — lives in the telemetry domain
 * (`~/lib/telemetry-dimension-names`), which is entry/ctx-free by construction. Adding a dimension
 * is one spec there plus its extractor in {@link DIMENSION_EXTRACTORS} here; record/persist/load/
 * snapshot in request-telemetry are all generic over dimension names, so no edits there. The
 * extractor table is a `Record` over the spec name union, so a spec without an extractor is a
 * COMPILE error rather than a silently-absent dimension.
 *
 * **`null` semantics**: an extractor returning `null` means "not applicable to this request" → the
 * request is NOT counted under that dimension. Per-dimension request totals may therefore
 * legitimately differ (e.g. `tool` only counts requests that invoked a tool; `client` only counts
 * requests whose inbound `user-agent` we saw). The `model`, `endpoint`, and `agentKind` dimensions
 * never return `null`, so their totals always equal the settled-request count. Empty/whitespace
 * keys are normalized to `"unknown"` by request-telemetry.
 *
 * **multi-key**: an extractor may return `string[]` (e.g. `tool` — one request can invoke several
 * tools). request-telemetry dedups and accumulates once per distinct key.
 */

import type {
  //
  TelemetryDimensionName,
  TelemetryDimensionSpec,
  ThinkingBlockCounts,
} from "@hsupu/ghc-proxy-telemetry"

import { TELEMETRY_DIMENSION_SPECS } from "@hsupu/ghc-proxy-telemetry"

import type { HistoryEntryData } from "~/lib/context/types"
import type { RequestContextSnapshot } from "~/lib/observability/events"

import { getHeaderCaseInsensitive } from "~/lib/fetch-utils"

/**
 * The upstream response content envelope for tool-name / thinking-block
 * extraction: the final attempt's `upstreamResponse.body`.
 */
function resolveUpstreamContent(entry: HistoryEntryData): unknown {
  return entry.attempts?.at(-1)?.upstreamResponse?.body
}

/** Resolve one request's key(s) for a dimension. `null` = not applicable (skip); `string[]` = multi-key. */
export type TelemetryKeyExtractor = (entry: HistoryEntryData, ctx: RequestContextSnapshot) => string | Array<string> | null

/** A registered telemetry dimension: its domain-owned spec (name + cardinality) plus its core-owned extractor. */
export interface StatDimension extends TelemetryDimensionSpec {
  extract: TelemetryKeyExtractor
}

/**
 * Normalize an inbound `user-agent` to a low-cardinality client bucket: the
 * leading product token before the first `/` or whitespace, lowercased (so
 * `claude-cli/1.2.3` → `claude-cli`, collapsing versions). `null` when no
 * inbound `user-agent` was captured (the dimension then skips this request).
 */
export function normalizeClient(headers: Record<string, string> | undefined): string | null {
  const ua = getHeaderCaseInsensitive(headers, "user-agent")
  if (!ua) return null
  const token = ua.trim().split(/[/\s]/, 1)[0]?.toLowerCase()
  return token || "unknown"
}

/**
 * Extract the distinct tool names the upstream response invoked, from the
 * proxy-recorded `outboundResponse.content` envelope. Handles both shapes the
 * recording layer produces: Anthropic-style content-block arrays (`type:"tool_use"`
 * with `name`) and OpenAI/Responses-style `tool_calls[].function.name`. Returns the
 * WIRE tool names (the restored-name mapper lives on `ctx`, not the entry — see RFC
 * caveat; with the default `sanitizeToolNames: false`, wire == client name).
 */
export function extractToolNames(entry: HistoryEntryData): Array<string> {
  const content = resolveUpstreamContent(entry)
  if (!content || typeof content !== "object") return []
  const names = new Set<string>()

  const blocks = (content as { content?: unknown }).content
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue
      if ((block as { type?: unknown }).type !== "tool_use") continue
      const name = (block as { name?: unknown }).name
      if (typeof name === "string" && name) names.add(name)
    }
  }

  const toolCalls = (content as { tool_calls?: unknown }).tool_calls
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      const name = (call as { function?: { name?: unknown } } | null)?.function?.name
      if (typeof name === "string" && name) names.add(name)
    }
  }

  return [...names]
}

/**
 * Tally the assistant response's thinking blocks into {@link ThinkingBlockCounts}. Mirrors
 * {@link extractToolNames}: reads the proxy-recorded `outboundResponse.content` envelope and
 * defends against its `unknown` shape. Filters to `type === "thinking"` FIRST (so
 * `redacted_thinking` — which has `data`, no `thinking` — and text/tool_use never mis-bucket),
 * then classifies by `thinking` emptiness + `signature` presence. Non-Anthropic responses (CC's
 * `content.content` is a string, not an array) yield all-zero — the `Array.isArray` guard skips them.
 */
export function extractThinkingBlockCounts(entry: HistoryEntryData): ThinkingBlockCounts {
  const counts: ThinkingBlockCounts = { nonEmpty: 0, emptySigned: 0, emptyUnsigned: 0 }
  const content = resolveUpstreamContent(entry)
  if (!content || typeof content !== "object") return counts

  const blocks = (content as { content?: unknown }).content
  if (!Array.isArray(blocks)) return counts

  for (const block of blocks) {
    if (!block || typeof block !== "object") continue
    if ((block as { type?: unknown }).type !== "thinking") continue

    const thinking = (block as { thinking?: unknown }).thinking
    if (typeof thinking === "string" && thinking.trim() !== "") {
      counts.nonEmpty += 1
      continue
    }

    // Empty thinking text — split by signature presence (the corruption discriminant).
    const signature = (block as { signature?: unknown }).signature
    if (typeof signature === "string" && signature !== "") counts.emptySigned += 1
    else counts.emptyUnsigned += 1
  }

  return counts
}

/**
 * The extractor for every registered dimension name. Exhaustive by TYPE: the `Record` is keyed by
 * the spec name union, so adding a spec in `telemetry-dimension-names.ts` without adding its
 * extractor here fails to compile (rather than yielding a dimension that silently records nothing).
 */
const DIMENSION_EXTRACTORS: Record<TelemetryDimensionName, TelemetryKeyExtractor> = {
  // Resolved/requested live under the `model` parent key (RFC §2.5).
  model: (entry) => entry.model?.resolved ?? entry.model?.requested ?? "unknown",
  endpoint: (entry) => entry.endpoint,
  client: (entry) => normalizeClient(entry.clientRequest?.headers),
  agentKind: (entry) => (entry.agentId ? "subagent" : "main"),
  tool: (entry) => extractToolNames(entry),
  max_tokens_truncation: (entry) => entry.pipelineInfo?.maxTokensContinuation?.truncationClass ?? null,
}

/** The registered dimensions — each domain-owned spec joined with its core-owned extractor. */
export const TELEMETRY_DIMENSIONS: ReadonlyArray<StatDimension> = TELEMETRY_DIMENSION_SPECS.map((spec) => ({
  ...spec,
  extract: DIMENSION_EXTRACTORS[spec.name],
}))

/** Resolve every registered dimension's key(s) for one settled request. */
export function extractTelemetryKeys(entry: HistoryEntryData, ctx: RequestContextSnapshot): Record<string, string | Array<string> | null> {
  const keys: Record<string, string | Array<string> | null> = {}
  for (const dim of TELEMETRY_DIMENSIONS) keys[dim.name] = dim.extract(entry, ctx)
  return keys
}

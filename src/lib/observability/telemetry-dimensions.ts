/**
 * Telemetry dimension registry (sink layer).
 *
 * A dimension is a registered key-extractor over a settled request's `entry` (+
 * `ctx`, for ctx-derived dimensions). The sink computes the per-dimension keys
 * HERE — where the entry/ctx types are in scope — and hands `request-telemetry.ts`
 * a plain `Record<dimName, key | key[] | null>`, keeping that aggregation leaf
 * type-light (it never imports entry/ctx, only the resolved keys).
 *
 * Adding a dimension is one push to {@link TELEMETRY_DIMENSIONS}; record/persist/
 * load/snapshot in request-telemetry are all generic over dimension names, so no
 * edits there.
 *
 * **`null` semantics**: an extractor returning `null` means "not applicable to this
 * request" → the request is NOT counted under that dimension. Per-dimension request
 * totals may therefore legitimately differ (e.g. `tool` only counts requests that
 * invoked a tool; `client` only counts requests whose inbound `user-agent` we saw).
 * The `model`, `endpoint`, and `agentKind` dimensions never return `null`, so their
 * totals always equal the settled-request count. Empty/whitespace keys are
 * normalized to `"unknown"` by request-telemetry.
 *
 * **multi-key**: an extractor may return `string[]` (e.g. `tool` — one request can
 * invoke several tools). request-telemetry dedups and accumulates once per distinct
 * key.
 *
 * **cardinality**: `bounded` dimensions have a naturally small key space (model /
 * endpoint / agentKind). `capped` dimensions (client / tool) are user/agent-driven
 * and potentially unbounded, so request-telemetry caps their key count and merges
 * overflow into `"other"` (see {@link CAPPED_DIMENSION_NAMES}).
 */

import type { HistoryEntryData } from "~/lib/context/types"
import type { RequestContextSnapshot } from "~/lib/observability/events"

import { getHeaderCaseInsensitive } from "~/lib/fetch-utils"

/**
 * The upstream response content envelope for tool-name / thinking-block
 * extraction. New model: the final attempt's `upstreamResponse.body`; falls back
 * to the deprecated top-level `outboundResponse.content` for legacy-only entries.
 * P4c: drop the `?? entry.outboundResponse?.content` fallback once legacy legs go.
 */
function resolveUpstreamContent(entry: HistoryEntryData): unknown {
  return entry.attempts?.at(-1)?.upstreamResponse?.body ?? entry.outboundResponse?.content
}

/** A registered telemetry dimension: a name + an entry/ctx → key extractor. */
export interface StatDimension {
  name: string
  /** Resolve this request's key(s) for the dimension. `null` = not applicable (skip); `string[]` = multi-key. */
  extract: (entry: HistoryEntryData, ctx: RequestContextSnapshot) => string | Array<string> | null
  /**
   * Key-space size class. `bounded` = naturally small (no cap). `capped` =
   * user/agent-driven, potentially unbounded → request-telemetry bounds the key
   * count and merges overflow into `"other"`. Defaults to `bounded`.
   */
  cardinality?: "bounded" | "capped"
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
 * Per-request tally of the assistant response's thinking blocks, split by content emptiness +
 * signature presence. The measure-input shape (owned here — the extractor's output; re-used by
 * `request-telemetry.ts`'s `SettledTelemetryInput.thinkingBlocks` via `import type`):
 * - `nonEmpty`      — `thinking` is a non-blank string (real reasoning text).
 * - `emptySigned`   — `thinking` blank but `signature` a non-empty string (normal encrypted /
 *   compat block — Anthropic thinking is self-contained in the signature).
 * - `emptyUnsigned` — `thinking` blank AND `signature` empty/missing/null (a corrupt double-empty
 *   block — the upstream-corruption signal `thinkingBlockSanitizeCheck.empty_thinking` strips).
 */
export interface ThinkingBlockCounts {
  nonEmpty: number
  emptySigned: number
  emptyUnsigned: number
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
 * The registered dimensions. Order is irrelevant (keys are name-addressed).
 * `model` is the back-compat dimension projected to
 * `RequestTelemetrySnapshot.modelsSinceStart` / `modelsLast7d`.
 *
 * **Cardinality**: `model`/`client`/`tool` are all `capped` — their keys derive
 * from CLIENT-controlled input (the raw `inboundRequest.model` is forwarded
 * verbatim and recorded even on an upstream-400 failure; user-agent; tool names),
 * so an abusive/buggy client could otherwise grow the key set without bound (memory
 * leak + a `/metrics` cardinality bomb). Only `endpoint` (a 4-value route enum) and
 * `agentKind` (`main`/`subagent`) are genuinely `bounded` and skip the cap.
 */
export const TELEMETRY_DIMENSIONS: ReadonlyArray<StatDimension> = [
  // New model: resolved/requested live under the `model` parent key (RFC §2.5);
  // fall back to the deprecated `outboundResponse.model` then the raw inbound
  // model. P4c: drop the `?? entry.outboundResponse?.model` fallback with legacy legs.
  {
    name: "model",
    cardinality: "capped",
    extract: (entry) => entry.model?.resolved ?? entry.model?.requested ?? entry.outboundResponse?.model ?? entry.inboundRequest.model ?? "unknown",
  },
  { name: "endpoint", cardinality: "bounded", extract: (entry) => entry.endpoint },
  { name: "client", cardinality: "capped", extract: (entry) => normalizeClient(entry.httpHeaders?.inboundRequest) },
  { name: "agentKind", cardinality: "bounded", extract: (entry) => (entry.agentId ? "subagent" : "main") },
  { name: "tool", cardinality: "capped", extract: (entry) => extractToolNames(entry) },
]

/** The capped (high-cardinality) dimension names, passed to `recordSettledRequest` so it bounds their key counts. */
export const CAPPED_DIMENSION_NAMES: ReadonlySet<string> = new Set(TELEMETRY_DIMENSIONS.filter((dim) => dim.cardinality === "capped").map((dim) => dim.name))

/** All registered dimension names — `/api/stats` validates the requested `dimension` against this list. */
export const TELEMETRY_DIMENSION_NAMES: ReadonlyArray<string> = TELEMETRY_DIMENSIONS.map((dim) => dim.name)

/** Resolve every registered dimension's key(s) for one settled request. */
export function extractTelemetryKeys(entry: HistoryEntryData, ctx: RequestContextSnapshot): Record<string, string | Array<string> | null> {
  const keys: Record<string, string | Array<string> | null> = {}
  for (const dim of TELEMETRY_DIMENSIONS) keys[dim.name] = dim.extract(entry, ctx)
  return keys
}

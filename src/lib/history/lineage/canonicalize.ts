/**
 * Lineage canonicalization.
 *
 * Transforms a (possibly noisy) Anthropic-shaped messages array into a stable
 * byte-deterministic form suitable for hashing. Empirically-derived rules
 * (see RFC §2.4):
 *
 *   1. Strip `cache_control` everywhere (migrates forward each turn, 100%
 *      miss rate without).
 *   2. Drop whole `<system-reminder>` text blocks at top-level
 *      `messages[].content[]` (per-turn drifting state).
 *   3. Substitute image `source.data` (base64) with its sha256 digest
 *      (perf — avoids re-hashing hundreds of KB per turn cumulatively).
 *   4. Filter out empty/whitespace-only text blocks (mirrors
 *      `recording.ts:mapAnthropicContentBlocks` which the server already
 *      applies to the recorded assistant message; symmetry on both sides
 *      of the prefix-equality check).
 *
 * Lineage canonicalization is **lineage-only** — the stored `inboundRequest`
 * is untouched (principle 7 "history records raw").
 */

import { createHash } from "node:crypto"

import type {
  //
  ContentBlockParam,
  MessageParam,
} from "~/types/api/anthropic"

/** SHA-256 of a string, returned as lowercase hex. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

/**
 * Generic in-order tree walk; visits each object/array/scalar exactly once.
 *
 * Anthropic message payloads are derived from `JSON.parse` and therefore
 * acyclic; this helper does NOT guard against cycles. If a future call site
 * introduces non-JSON-derived input (e.g. Buffer instances inside a
 * structuredClone output), add a `Set<unknown>` visited guard.
 */
function walkObject(node: unknown, visit: (n: unknown) => void): void {
  visit(node)
  if (node && typeof node === "object") {
    for (const v of Array.isArray(node) ? node : Object.values(node)) {
      walkObject(v, visit)
    }
  }
}

/** Recursively delete every `cache_control` key. Mutates a clone of input. */
function stripCacheControlDeep<T>(obj: T): T {
  // structuredClone preserves Uint8Array / Buffer semantics that
  // JSON.parse(JSON.stringify) drops; safer for arbitrary content blocks.
  const cloned = structuredClone(obj)
  walkObject(cloned, (node) => {
    if (node && typeof node === "object" && "cache_control" in node) {
      delete (node as Record<string, unknown>).cache_control
    }
  })
  return cloned
}

/**
 * Image source data can be hundreds of KB of base64. The cumulative hash
 * chain would touch each one O(N) times across a long conversation, so we
 * substitute the data field with its digest before serialization. The
 * digest is byte-stable for identical input.
 */
function substituteImageDataDigest(block: ContentBlockParam): ContentBlockParam {
  if (block.type !== "image") return block
  const b = block as unknown as { type: "image"; source?: { data?: string; [k: string]: unknown } }
  const source = b.source
  if (!source || typeof source.data !== "string") return block
  const { data, ...rest } = source
  return {
    ...b,
    source: { ...rest, _dataDigest: sha256Hex(data) },
  } as unknown as ContentBlockParam
}

/**
 * Whole-block `<system-reminder>` detection. Strict open + close match so a
 * block that mixes a reminder with stable user text (theoretical edge —
 * not seen in current Claude Code traffic) is NOT collapsed (which would
 * cause a false-merge across distinct prompts).
 *
 * `trimEnd` accepts trailing whitespace after `</system-reminder>` (observed
 * in live data — see RFC §3 round-2 verification probe).
 */
function isSystemReminderTextBlock(block: ContentBlockParam): boolean {
  if (block.type !== "text") return false
  const text = (block as { text?: unknown }).text
  if (typeof text !== "string") return false
  const trimmed = text.trimEnd()
  return trimmed.startsWith("<system-reminder>") && trimmed.endsWith("</system-reminder>")
}

/**
 * Empty / whitespace-only text blocks. Mirrors the server-side filter in
 * `src/lib/request/recording.ts` so client-echoed assistant messages
 * canonicalize the same way the server's `outboundResponse.content` did.
 */
function isEmptyTextBlock(block: ContentBlockParam): boolean {
  if (block.type !== "text") return false
  const text = (block as { text?: unknown }).text
  if (typeof text !== "string") return true
  return text.trim() === ""
}

function canonicalizeMessage(msg: MessageParam): MessageParam {
  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content }
  }
  const content = msg.content
    .map((b) => stripCacheControlDeep(b))
    .map((b) => substituteImageDataDigest(b))
    .filter((b) => !isSystemReminderTextBlock(b))
    .filter((b) => !isEmptyTextBlock(b))
  return { role: msg.role, content }
}

/** Canonicalize the full messages array. Idempotent. */
export function canonicalizeMessages(messages: ReadonlyArray<MessageParam>): Array<MessageParam> {
  return messages.map((m) => canonicalizeMessage(m))
}

/**
 * Stable, byte-deterministic JSON serialization. Object keys sorted
 * lexicographically; no whitespace; arrays preserve order. Same input →
 * same output byte-for-byte across runs.
 *
 * NOTE: V8 sorts strings as UTF-16 code units, which differs from a
 * codepoint sort for surrogates. All Anthropic field names are ASCII so
 * the distinction does not matter here. Cross-language reimplementations
 * must sort the same way.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(",") + "]"
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts: Array<string> = []
  for (const k of keys) {
    const v = obj[k]
    if (v === undefined) continue
    parts.push(JSON.stringify(k) + ":" + canonicalJson(v))
  }
  return "{" + parts.join(",") + "}"
}

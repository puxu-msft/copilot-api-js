/**
 * Single-owner message normalization for the content-addressed search index.
 *
 * `normalizeMessageForIndex` is the ONE projection that is simultaneously:
 *   1. the HASH input (`hashMessage`) — identity for cross-turn message dedup, and
 *   2. the STORED search text — what LIKE/substring search scans.
 * Equality, dedup, and search therefore see one consistent view (see
 * docs/spec/search-index-content-addressed.md, decision 8 + reviewer Finding 5).
 *
 * It is **config-independent, deterministic, and stable**: the same message
 * always yields the same string, regardless of runtime config. Two properties
 * make cross-turn dedup work:
 *
 * - **cache_control is dropped recursively.** Claude Code moves the
 *   `cache_control: {type:"ephemeral"}` breakpoint forward each turn, so a
 *   historical message that is otherwise byte-identical across turns differs
 *   ONLY by where that marker sits. Empirically verified against two consecutive
 *   live requests (memory `empirical-probe-via-history-api`): recursively
 *   stripping `cache_control` makes the shared message byte-equal; not stripping
 *   it re-hashes the message every turn and dedup degenerates to a full re-index.
 *
 * - **Injected boilerplate is stripped from prose text.** `<system-reminder>`,
 *   `<ide_opened_file>`, `<ide_diagnostics>`, `<ide_selection>` blocks are
 *   per-turn-volatile editor/session context AND search noise, so they are
 *   removed. Stripping is **own-line boundary-anchored**, NOT a global regex:
 *   real Claude Code transcripts contain legitimate INLINE literal mentions of
 *   these tag names (e.g. documentation that discusses them) which must stay
 *   searchable — only structurally-injected own-line blocks are removed.
 *
 * Deliberately **NOT reused**: `removeSystemReminderTags`
 * (`system-prompt/reminder.ts`) reads `state.rewriteSystemReminders` and is
 * gated to a no-op by default — making the projection config-dependent. The
 * stripping here is unconditional and self-contained so the hash never shifts
 * with config. (Reviewer Finding 4 wanted battle-tested surgery; this reuses the
 * SAME own-line boundary approach, config-free.)
 *
 * NOTE for the P1 read path: the returned string is the canonical JSON form
 * (deterministic key order), so punctuation in user text is JSON-escaped (e.g.
 * `"` → `\"`). Substring/LIKE search built on this column in P1 must normalize
 * the query the same way (or search a de-escaped projection) — token/identifier
 * searches are unaffected; only literal quote/backslash/newline queries need it.
 */

import { createHash } from "node:crypto"

import type { MessageContent } from "./types"

/** Width of the truncated SHA-256 message hash: 16 bytes → 32 hex chars. */
export const MSG_HASH_BYTES = 16

/** Wire format a message originated from — guides shape-specific prose extraction. */
export type MessageFormat = "anthropic" | "openai" | "gemini"

/**
 * Object keys removed recursively at every depth before hashing. `cache_control`
 * is the proven per-turn-volatile marker; `ephemeral` is dropped defensively in
 * case it ever appears as a standalone sibling field.
 */
const VOLATILE_KEYS = new Set(["cache_control", "ephemeral"])

/** Injected boilerplate tags stripped from prose text (own-line blocks only). */
const BOILERPLATE_TAGS = ["system-reminder", "ide_opened_file", "ide_diagnostics", "ide_selection"]

/**
 * One own-line block matcher per tag. Anchored so it only matches a tag that
 * STARTS its own line and whose closing tag ENDS its own line — inline literal
 * mentions (backtick-wrapped, embedded in prose) never match and stay
 * searchable. Lazy inner match handles both single-line and multi-line blocks.
 * `\r` is tolerated on the boundaries so CRLF transcripts (Windows clients / IDE
 * injections) strip identically to LF — else a CRLF-encoded volatile block would
 * survive into the hash and re-hash the message every turn.
 */
const BOILERPLATE_BLOCK_REGEXES = BOILERPLATE_TAGS.map((tag) => new RegExp(`(?:^|\\n)[ \\t]*<${tag}>[\\s\\S]*?</${tag}>[ \\t\\r]*(?=\\n|$)`, "g"))

/** Remove structurally-injected boilerplate blocks from a single text string. */
function stripBoilerplateTags(text: string): string {
  let out = text
  for (const re of BOILERPLATE_BLOCK_REGEXES) out = out.replace(re, "")
  // Trim only the whole-string ends left bare by removal — deterministic and
  // stable (the same input always trims identically), so dedup is unaffected.
  return out.trim()
}

/** True for the `{ type: "text", text }` block shape (Anthropic + OpenAI parts). */
function isTextBlock(block: unknown): block is { text: string } {
  return typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string"
}

/** Strip boilerplate from the `text` member of every text-bearing array element. */
function stripBlockArrayText(blocks: Array<unknown>): Array<unknown> {
  return blocks.map((block) => {
    if (isTextBlock(block)) return { ...block, text: stripBoilerplateTags(block.text) }
    // Anthropic tool_result content nests another string | text-block array.
    if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "tool_result") {
      const b = block as { content?: unknown }
      if (typeof b.content === "string") return { ...block, content: stripBoilerplateTags(b.content) }
      if (Array.isArray(b.content)) return { ...block, content: stripBlockArrayText(b.content) }
    }
    return block
  })
}

/**
 * Return a copy of `msg` with boilerplate stripped from its prose text fields.
 * Tool-call arguments / structured non-prose fields are intentionally left
 * untouched (they are data, not injected context).
 *
 * `format` is the per-message index contract (callers tag each message with its
 * origin wire format). The text-member strip is intentionally shape-agnostic and
 * handles all three shapes uniformly — Anthropic content-block unions (text +
 * nested tool_result), and OpenAI/Gemini loose parts whose text lives on `.text`
 * — so identical content normalizes (and dedups) the same regardless of format.
 * Format is therefore NOT mixed into the hash: content-addressed identity is over
 * normalized content only.
 */
function stripProseText(msg: MessageContent, format: MessageFormat): MessageContent {
  void format
  const content = msg.content
  if (typeof content === "string") return { ...msg, content: stripBoilerplateTags(content) }
  if (!Array.isArray(content)) return msg
  return { ...msg, content: stripBlockArrayText(content) }
}

/**
 * Recursively rebuild `value` with volatile keys dropped and object keys sorted,
 * yielding a canonical tree whose `JSON.stringify` is order-independent.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    if (VOLATILE_KEYS.has(key)) continue
    if (obj[key] === undefined) continue
    out[key] = canonicalize(obj[key])
  }
  return out
}

/**
 * Project a message to its canonical normalized text (hash input AND stored
 * search text). Config-independent, deterministic, stable across turns.
 */
export function normalizeMessageForIndex(msg: MessageContent, format: MessageFormat): string {
  const stripped = stripProseText(msg, format)
  // content:undefined → null so a content-less message hashes consistently.
  const envelope: Record<string, unknown> = { ...stripped, content: stripped.content ?? null }
  return JSON.stringify(canonicalize(envelope))
}

/**
 * Content-addressed message identity: SHA-256 of the normalized projection,
 * truncated to `MSG_HASH_BYTES` (128-bit → 32 hex chars; reviewer Finding 6).
 */
export function hashMessage(msg: MessageContent, format: MessageFormat): string {
  const normalized = normalizeMessageForIndex(msg, format)
  return createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex")
    .slice(0, MSG_HASH_BYTES * 2)
}

/**
 * Concatenated normalized text of a request's inbound messages — the SAME
 * projection the persistent index stores per message, so an in-flight (not-yet-
 * indexed) entry searches identically to a persisted one. Used by the
 * in-memory scan over active entries (queries.ts).
 */
export function extractInboundSearchText(messages: ReadonlyArray<MessageContent>, format: MessageFormat): string {
  return messages.map((msg) => normalizeMessageForIndex(msg, format)).join("\n")
}

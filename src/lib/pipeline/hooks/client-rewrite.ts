/**
 * `client.inbound` request-rewrite helpers (RFC 2026-07-14-symmetric-four-point-hooks §4.1).
 *
 * A `client.inbound` hook sees the client-NATIVE body of ONE of four inbound formats (Phase 3's
 * four-format downshift guarantees each is native at S1a→S1b). Each format lays its conversation
 * turns out differently, so these helpers dispatch on `env.clientFormat` to a per-format accessor
 * and rebuild the body IMMUTABLY (returning a NEW env via `env.with` — never mutating in place; the
 * driver also defends with a body snapshot, §3.5):
 *
 *   | clientFormat        | turn list        | system carrier        |
 *   |---------------------|------------------|-----------------------|
 *   | anthropic           | `body.messages`  | `body.system` (top)   |
 *   | openai-cc           | `body.messages`  | a `role:"system"` msg |
 *   | openai-responses    | `body.input`     | `body.instructions`   |
 *   | gemini              | `body.contents`  | `body.systemInstruction` |
 *
 * `mapClientMessages` walks the turn list (drop a turn by returning `null`); `stripMessageBlock` is
 * the common convenience over it (drop turns a predicate matches). Both leave the format's other
 * fields untouched — a caller wanting to strip system-carrier text uses `stripSystemText`.
 */

import type { RequestEnvelope } from "~/lib/pipeline/envelope"

/** A conversation turn as seen by a `client.inbound` hook (format-native; role + opaque content). */
export interface ClientTurn {
  readonly role: string
  /** The turn's raw object (format-native); `content`/`parts`/etc. live here. */
  readonly raw: Record<string, unknown>
  /** Plain-text projection of the turn's content (concatenated), for predicate matching. */
  readonly text: string
}

type Body = Record<string, unknown>

/** Concatenate the text of a cc/anthropic message `content` (string | array of {type:"text",text}). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? ((b as { text?: string }).text ?? "") : "")).join("")
}

/** Concatenate the text of a gemini content `parts` (array of {text}). */
function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts.map((p) => (p && typeof p === "object" ? ((p as { text?: string }).text ?? "") : "")).join("")
}

/** Read the turn list + a text projector for the given format. */
function turnListKey(format: string): { key: string; project: (turn: Record<string, unknown>) => string } | undefined {
  switch (format) {
    case "anthropic":
    case "openai-cc": {
      return { key: "messages", project: (t) => messageText(t.content) }
    }
    case "openai-responses": {
      // Responses `input` items: message items carry `content` (array of {type,text}); others project empty.
      return { key: "input", project: (t) => messageText(t.content) }
    }
    case "gemini": {
      return { key: "contents", project: (t) => partsText(t.parts) }
    }
    default: {
      return undefined
    }
  }
}

/**
 * Immutably map over the client-native conversation turns. `fn` returns the (possibly replaced) turn
 * object, or `null` to DROP it. Returns a NEW env (or the same env unchanged if nothing changed / the
 * format has no walkable turn list). Format-native — the hook author reads `turn.raw` for the
 * verbatim object and `turn.text`/`turn.role` for matching.
 */
export function mapClientMessages(env: RequestEnvelope, fn: (turn: ClientTurn) => Record<string, unknown> | null): RequestEnvelope {
  const spec = turnListKey(env.clientFormat)
  if (!spec) return env
  const body = env.body as Body
  const list = body[spec.key]
  if (!Array.isArray(list)) return env

  let changed = false as boolean
  const out: Array<unknown> = []
  for (const item of list) {
    const raw = (item ?? {}) as Record<string, unknown>
    const turn: ClientTurn = { role: typeof raw.role === "string" ? raw.role : "", raw, text: spec.project(raw) }
    const kept = fn(turn)
    if (kept === null) {
      changed = true
      continue
    }
    if (kept !== raw) changed = true
    out.push(kept)
  }
  if (!changed) return env
  return env.with({ body: { ...body, [spec.key]: out } })
}

/**
 * Drop every conversation turn a `predicate` matches (a NEW env, immutable). The common
 * `client.inbound` use case: strip a client-injected boilerplate turn (e.g. a Claude-Code-injected
 * `role:"system"` TodoWrite reminder). Turns the predicate does not match pass through verbatim.
 */
export function stripMessageBlock(env: RequestEnvelope, predicate: (turn: ClientTurn) => boolean): RequestEnvelope {
  return mapClientMessages(env, (turn) => (predicate(turn) ? null : turn.raw))
}

/**
 * Strip text matching `pattern` from the format's SYSTEM carrier (Anthropic top-level `system`,
 * Responses `instructions`, Gemini `systemInstruction`) — for boilerplate injected as a system
 * prompt rather than a conversation turn. `openai-cc` has no system carrier (its system is a
 * `role:"system"` turn — use {@link stripMessageBlock} for that). Returns a NEW env (immutable);
 * a carrier that becomes empty is removed.
 */
export function stripSystemText(env: RequestEnvelope, pattern: RegExp): RequestEnvelope {
  const body = env.body as Body
  const strip = (s: string): string => s.replace(pattern, "").trim()

  switch (env.clientFormat) {
    case "anthropic": {
      const sys = body.system
      if (typeof sys === "string") {
        const next = strip(sys)
        return next === sys ? env : env.with({ body: next ? { ...body, system: next } : omit(body, "system") })
      }
      if (Array.isArray(sys)) {
        let changed = false as boolean
        const kept = sys
          .map((b) => {
            if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
              const t = strip((b as { text?: string }).text ?? "")
              if (t !== (b as { text?: string }).text) changed = true
              return t ? { ...(b as object), text: t } : null
            }
            return b
          })
          .filter((b) => b !== null)
        return changed ? env.with({ body: { ...body, system: kept } }) : env
      }
      return env
    }
    case "openai-responses": {
      const instr = body.instructions
      if (typeof instr !== "string") return env
      const next = strip(instr)
      return next === instr ? env : env.with({ body: next ? { ...body, instructions: next } : omit(body, "instructions") })
    }
    case "gemini": {
      const si = body.systemInstruction as { parts?: Array<{ text?: string }> } | undefined
      if (!si || !Array.isArray(si.parts)) return env
      let changed = false as boolean
      const parts = si.parts
        .map((p) => {
          const t = strip(p.text ?? "")
          if (t !== p.text) changed = true
          return t ? { ...p, text: t } : null
        })
        .filter((p) => p !== null)
      if (!changed) return env
      return env.with({ body: parts.length > 0 ? { ...body, systemInstruction: { ...si, parts } } : omit(body, "systemInstruction") })
    }
    default: {
      return env
    }
  }
}

/** Shallow object omit (returns a new object without `key`). */
function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _drop, ...rest } = obj
  return rest
}

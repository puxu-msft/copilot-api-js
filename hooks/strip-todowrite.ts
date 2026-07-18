/**
 * Example `client.inbound` hook (RFC 2026-07-14-symmetric-four-point-hooks §4.1) — strip the
 * Claude-Code-injected TodoWrite `role:"system"` boilerplate reminder from the client-native request
 * before it reaches the upstream (saves tokens; the reminder is noise for a proxied model).
 *
 * Works across all four inbound formats: the `role:"system"` reminder is a conversation turn in
 * anthropic / openai-cc (stripped via `stripMessageBlock`) and, for the formats that carry system
 * text out of band, in the Responses `instructions` / Gemini `systemInstruction` (stripped via
 * `stripSystemText`). Both are immutable (return a new env).
 *
 * Load: config `hooks.upstream_module: "./hooks/strip-todowrite.ts"` + `enabled: true`
 * (+ `POST /api/hooks/reload` to hot-reload after edits).
 */

import {
  //
  stripMessageBlock,
  stripSystemText,
} from "~/lib/pipeline/hooks"

const TODOWRITE = /The TodoWrite tool hasn't been used recently/

export const hooks = {
  client: {
    inbound: (env) => {
      // Drop any system TURN whose text is the TodoWrite reminder (anthropic / openai-cc), then
      // strip the reminder text from the out-of-band system carrier (responses / gemini / anthropic
      // top-level system). Chained — each returns a new env (or the same one unchanged).
      const afterTurns = stripMessageBlock(env, (turn) => turn.role === "system" && TODOWRITE.test(turn.text))
      return stripSystemText(afterTurns, TODOWRITE)
    },
  },
}

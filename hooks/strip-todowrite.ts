/**
 * Example `client.inbound` hook (RFC 2026-07-14-symmetric-four-point-hooks §4.1) — strip the
 * Claude-Code-injected TodoWrite `role:"system"` boilerplate reminder from the client-native request
 * before it reaches the upstream (saves tokens; the reminder is noise for a proxied model).
 *
 * Works across all four inbound formats: the `role:"system"` reminder is a conversation turn in
 * anthropic / openai-cc (stripped via `stripMessageBlock`) and, for the formats that carry system
 * text out of band, in the Responses `instructions` / Gemini `systemInstruction` (stripped via
 * `stripSystemText`). Both rebuild the BODY and hand back the SAME env object (`writeAttempt`) — the
 * envelope's scopes are mutable, so do not keep a reference to the pre-strip env expecting the old body.
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
      // top-level system). Chained — each hands back the SAME env carrying the new body (or that env
      // untouched if nothing matched), so passing the previous result along is exactly right.
      const afterTurns = stripMessageBlock(env, (turn) => turn.role === "system" && TODOWRITE.test(turn.text))
      return stripSystemText(afterTurns, TODOWRITE)
    },
  },
}

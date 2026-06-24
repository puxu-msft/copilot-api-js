/**
 * Non-streaming semantic-truncation detection (richest-data-flow / honesty).
 *
 * An upstream `200 OK` with a structurally-valid JSON body but NO protocol
 * terminator (Anthropic `stop_reason` / OpenAI `finish_reason` / Responses
 * non-terminal `status`) is a SEMANTICALLY truncated response — the streaming
 * path already catches its analog (a clean EOF without `message_stop` etc.), but
 * the non-streaming path used to silently record it as `complete` (`[OK]`, success
 * metrics inflated). These helpers return a reason string when the terminator is
 * absent so the handler records `fail()` instead (the partial body is still
 * forwarded to the client + preserved on the failed entry — richest-data-flow).
 *
 * Conservative by design: gate ONLY on the terminator (mirrors the streaming
 * detection's `sawMessageStop` / `finishReason !== ""` invariant). An empty body
 * WITH a present terminator (e.g. `stop_reason:"end_turn"` + empty content — a
 * legitimate refusal) is NOT flagged, to avoid false-positives on real completions.
 * Explicit terminal statuses (`incomplete` / `failed` / `max_tokens`) are real
 * upstream signals, not truncation, and are likewise not flagged.
 */

/** Anthropic Messages: a complete non-streaming response always carries `stop_reason`. */
export function anthropicNonStreamingTruncation(stopReason: string | null | undefined): string | null {
  return stopReason ? null : "upstream returned 200 without stop_reason (semantic truncation)"
}

/** OpenAI Chat Completions (+ Gemini, which renders from a CC response): a complete response carries `finish_reason`. */
export function openaiNonStreamingTruncation(finishReason: string | null | undefined): string | null {
  return finishReason ? null : "upstream returned 200 without finish_reason (semantic truncation)"
}

/**
 * OpenAI Responses: `status` is the terminator. `completed` / `incomplete` / `failed`
 * are explicit terminal statuses (not truncation); a missing or still-`in_progress`
 * status on a non-streaming body is the semantic-truncation signal.
 */
export function responsesNonStreamingTruncation(status: string | null | undefined): string | null {
  if (!status || status === "in_progress") return `upstream returned 200 with non-terminal status "${status ?? "missing"}" (semantic truncation)`
  return null
}

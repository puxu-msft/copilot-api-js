/**
 * Pure formatter for the canonical log line shape:
 *   [PREFIX] HH:MM:SS <status> <method> <path> <model> (<mult>x) <dur> <sessionBlock> ↑<req> ↓<resp> ↑<in>+<cache> ↻<hit%>+<new%> ↓<out> <stopReason>(<tools>) <thinking> <extra> <retryableMeta>
 *
 * Successful completion lines with a known inbound format collapse the
 * `<method> <path> <model>` columns to a single `<inputFormat>/<model>` token
 * (e.g. `anthropic/claude-opus-4.8`); failure/retry lines keep the full form.
 *
 * Shared source of truth for the log-line shape, consumed by
 * `~/lib/tui/terminal-ui.ts` (the TerminalUi renderer) and its `render/`
 * helpers. Lives under `observability/projections/` because it is a pure
 * formatter shared across consumers, not owned by the tui layer.
 *
 * The function is pure — no I/O, no global state — but reads
 * `state.tokenBasedBilling` via `formatBillingLabel` (account-wide
 * decision not carried on each call).
 */

import pc from "picocolors"

import type { ResponseThinking } from "~/lib/history/entry-view"
import type { EndpointType } from "~/lib/history/types"

import { modelRemapParts } from "~/lib/models/resolver"

import {
  //
  durationColor,
  formatBillingLabel,
  formatBytes,
  formatNumber,
  formatTokens,
  stopReasonColor,
} from "./format"
import { formatSessionBlock } from "./session-block"

/**
 * Compact inbound-format label shown on successful completion lines in place of
 * the `<method> <path>` columns — `<inputFormat>/<model>` (e.g.
 * `anthropic/claude-opus-4.8`). Derived from the client's inbound endpoint
 * (`ctx.endpoint`, an {@link EndpointType}); failure/retry lines keep the full
 * `<method> <path>` for debugging.
 */
export const INPUT_FORMAT_LABEL: Record<EndpointType, string> = {
  "anthropic-messages": "anthropic",
  "openai-chat-completions": "openai-cc",
  "openai-responses": "openai-re",
  "gemini-generate-content": "gemini",
}

export interface LogLineParts {
  prefix: string
  time: string
  method: string
  path: string
  /**
   * Inbound client format (`ctx.endpoint`). When present on a successful line
   * (not error/retry/dim), the `<method> <path> <model>` columns collapse to a
   * single `<inputFormat>/<model>` token via {@link INPUT_FORMAT_LABEL}. Absent
   * (e.g. synthetic count_tokens lines) → the full `<method> <path>` form.
   */
  inputFormat?: EndpointType
  /**
   * Session-identity block fields (rendered between the duration and the upload
   * bytes via {@link formatSessionBlock}): a `sessionId`-hashed colored glyph —
   * `■` for the main agent, `❶❷…` for subagents. `agentId` absent → main; present
   * → subagent numbered by `agentOrdinal` (first-seen order within the session,
   * supplied by the caller's AgentOrdinalRegistry). No `sessionId` → no block.
   */
  sessionId?: string
  agentId?: string
  agentOrdinal?: number
  model?: string
  /** Original model name from client (shown when different from resolved model) */
  clientModel?: string
  multiplier?: number
  status?: number
  duration?: string
  /** Raw duration in ms — colors {@link duration} by severity (durationColor); falls back to yellow when absent. */
  durationMs?: number
  requestBodySize?: number
  responseBodySize?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  queueWait?: string
  extra?: string
  /** Dim metadata appended at the end (e.g. "(retryable: network-retry, wait 1.0s)") */
  retryableMeta?: string
  /**
   * Response terminal stop_reason (e.g. "end_turn", "tool_use", "max_tokens").
   * Rendered as a category-colored `<reason>` token right after the token
   * counts (`↓<out>`) and before {@link extra}, so the grey feature-tag parens
   * stay the trailing element. The caller supplies it only on successful
   * completion lines (a failed/aborted request has no upstream stop_reason).
   * Color is by {@link stopReasonColor}.
   */
  stopReason?: string
  /**
   * Tool names invoked in the response, appended to the stop_reason token as
   * `tool_use(Bash,Edit)` (same category color). Rendered only when non-empty
   * AND {@link stopReason} is present; call order is preserved (not deduped).
   */
  toolNames?: Array<string>
  /**
   * Response-side thinking dimension (derived via
   * `history/entry-view.ts#resolveResponseThinking`). Rendered as a
   * `think:<…>(<blocks>)` token next to the stop_reason token: `think:<chars>`
   * gray when plaintext is present, `think:enc` gray for encrypted/redacted
   * (empty-plaintext-but-legitimate) thoughts, `think:poison` yellow for the
   * empty-plaintext poisoning case. Absent → no token (the response produced no
   * thinking blocks). See {@link formatThinkingToken}.
   */
  responseThinking?: ResponseThinking
  /** Request id (e.g. "req_178..."), appended dim on error lines for history lookup */
  reqId?: string
  isError?: boolean
  isRetry?: boolean
  isDim?: boolean
}

/**
 * Render a single log line with colored parts.
 *
 * Three visual variants:
 * - `isDim: true` — start lines, history-access lines: dim grey, minimal columns
 * - `isRetry: true` — yellow prefix, red status, red error, dim retryableMeta
 * - default — green prefix + status (success) or red (error), full columns
 */
export function formatLogLine(parts: LogLineParts): string {
  const {
    prefix,
    time,
    method,
    path,
    inputFormat,
    sessionId,
    agentId,
    agentOrdinal,
    model,
    clientModel,
    multiplier,
    status,
    duration,
    durationMs,
    requestBodySize,
    responseBodySize,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    queueWait,
    extra,
    retryableMeta,
    stopReason,
    toolNames,
    responseThinking,
    reqId,
    isError,
    isRetry,
    isDim,
  } = parts

  if (isDim) {
    const modelPart = model ? ` ${model}` : ""
    const extraPart = extra ? ` ${extra}` : ""
    return pc.dim(`${prefix} ${time} ${method} ${path}${modelPart}${extraPart}`)
  }

  // Colored lines: each part has its own color
  let coloredPrefix: string
  if (isRetry) {
    coloredPrefix = pc.yellow(prefix)
  } else {
    coloredPrefix = isError ? pc.red(prefix) : pc.green(prefix)
  }
  const coloredTime = pc.dim(time)
  let coloredStatus: string | undefined
  if (status !== undefined) {
    // Retry lines carry a failure status; render red like [FAIL].
    const statusIsFailure = isError || isRetry
    coloredStatus = statusIsFailure ? pc.red(String(status)) : pc.green(String(status))
  }
  const coloredMethod = pc.white(method)
  const coloredPath = pc.white(path)

  // Successful lines with a known inbound format collapse the `<method> <path> <model>`
  // columns to a single `<inputFormat>/<model>` token (e.g. `anthropic/claude-opus-4.8`);
  // failure/retry lines keep the full `<method> <path>` for debugging.
  const compact = !isError && !isRetry && inputFormat !== undefined && model !== undefined

  // Model token WITHOUT a leading space, so both the full form (which adds its
  // own space) and the compact `<inputFormat>/<model>` form can reuse it. Shows
  // "clientModel → model" only on a genuine remap — the `source`/`target` split
  // (suppress-when-same-model) is shared with the detail view via
  // {@link modelRemapParts}; styling (dim source / magenta target) is ours.
  let modelToken = ""
  if (model !== undefined) {
    const { source, target } = modelRemapParts(clientModel, model)
    modelToken = source ? `${pc.dim(source)} → ${pc.magenta(target)}` : pc.magenta(target)
  }
  const coloredModel = model === undefined ? "" : ` ${modelToken}`
  const coloredMultiplier = pc.dim(formatBillingLabel(multiplier))
  // Duration is severity-colored by raw ms (durationColor) at every production
  // call site (retry + terminal both pass durationMs); the plain-yellow branch
  // is a defensive fallback for any caller that supplies only the string.
  const durationColorFn = durationMs !== undefined ? durationColor(durationMs) : pc.yellow
  const coloredDuration = duration ? ` ${durationColorFn(duration)}` : ""
  const coloredQueueWait = queueWait ? ` ${pc.dim(`(queued ${queueWait})`)}` : ""

  // Session-identity block (`■` main / `❶❷…` subagent, sessionId-hashed color),
  // placed between the duration and the upload bytes. Empty when no sessionId.
  const block = formatSessionBlock({ sessionId, agentId, agentOrdinal })
  const blockPart = block ? ` ${block}` : ""

  // req/resp body sizes with ↑↓ arrows
  let sizeInfo = ""
  if (model) {
    const reqSize = requestBodySize !== undefined ? `↑${formatBytes(requestBodySize)}` : ""
    const respSize = responseBodySize !== undefined ? `↓${formatBytes(responseBodySize)}` : ""
    const sizes = [reqSize, respSize].filter(Boolean).join(" ")
    if (sizes) sizeInfo = ` ${pc.dim(sizes)}`
  }

  // in-tokens/out-tokens (cache breakdown + woven-in cache-rate marker `↻…`,
  // which formatTokens places between the input group and ↓output).
  let tokenInfo = ""
  if (model && (inputTokens !== undefined || outputTokens !== undefined)) {
    tokenInfo = ` ${formatTokens(inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens)}`
  }

  let extraPart = ""
  if (extra) {
    // Retry lines reuse the same red coloring as [FAIL] for the error message.
    extraPart = isError || isRetry ? pc.red(extra) : extra
  }

  // Dim metadata (e.g. retry strategy info) appended after the error message.
  const retryableMetaPart = retryableMeta ? ` ${pc.dim(retryableMeta)}` : ""

  // Terminal stop_reason token (`<reason>`), the whole token category-colored by
  // stopReasonColor (green for normal end_turn, white for tool_use — cyan when the
  // response asked the user via AskUserQuestion, yellow for truncation, red for
  // refusal/error). When the response invoked tools, their names are appended as
  // `tool_use(Bash,Edit)` inside the same colored token. Placed right after the
  // token counts and before extraPart so the grey feature-tag parens stay last.
  // Present only when the caller supplies a reason — i.e. on successful completion lines.
  const toolSuffix = toolNames && toolNames.length > 0 ? `(${toolNames.join(",")})` : ""
  const stopReasonPart = stopReason ? ` ${stopReasonColor(stopReason, toolNames)(`${stopReason}${toolSuffix}`)}` : ""

  // Response-side thinking token (`think:…(<blocks>)`), placed right after the
  // stop_reason token. Absent when the response produced no thinking blocks.
  const thinkingPart = responseThinking ? ` ${formatThinkingToken(responseThinking)}` : ""

  // Request id appended dim at the very end (only when provided, e.g. error lines) for history lookup.
  const reqIdPart = reqId ? ` ${pc.dim(reqId)}` : ""

  // Location segment between the status and the multiplier badge:
  //   compact form → `<inputFormat>/<model>` (dim label + magenta model token)
  //   full form    → `<method> <path> <model>`
  const locationSegment = compact ? `${pc.dim(`${INPUT_FORMAT_LABEL[inputFormat]}/`)}${modelToken}` : `${coloredMethod} ${coloredPath}${coloredModel}`
  const statusAndLocation = coloredStatus ? `${coloredStatus} ${locationSegment}` : locationSegment

  return `${coloredPrefix} ${coloredTime} ${statusAndLocation}${coloredMultiplier}${coloredDuration}${coloredQueueWait}${blockPart}${sizeInfo}${tokenInfo}${stopReasonPart}${thinkingPart}${extraPart}${retryableMetaPart}${reqIdPart}`
}

/**
 * Render the response-side {@link ResponseThinking} dimension as a compact
 * completion-line token. Three visual states:
 *   - plaintext present → `think:<abbrev chars>(<blocks>)` gray
 *   - encrypted / redacted (empty plaintext, not poisoned) → `think:enc(<blocks>)` gray
 *   - poisoned (empty plaintext, no signature) → `think:poison(<blocks>)` yellow
 * The `poisoned` verdict takes precedence over any char count (defensive — the
 * derivation makes them mutually exclusive, but a poison verdict must never show
 * a friendly count). Gray tokens use `pc.gray` (the encrypted/normal case is
 * low-key); the poison case is `pc.yellow` to surface the anomaly.
 */
export function formatThinkingToken(rt: ResponseThinking): string {
  const suffix = `(${rt.blockCount})`
  if (rt.poisoned) return pc.yellow(`think:poison${suffix}`)
  const body = rt.chars > 0 ? formatNumber(rt.chars) : "enc"
  return pc.gray(`think:${body}${suffix}`)
}

/**
 * Pure formatter for the canonical log line shape:
 *   [PREFIX] HH:MM:SS <status> <method> <path> <model> (<mult>x) <dur> ↑<req> ↓<resp> ↑<in>+<cache> ↓<out> ↻<hit%>+<new%> <extra> <retryableMeta>
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

import { isSameModelName } from "~/lib/models/resolver"

import {
  //
  formatBillingLabel,
  formatBytes,
  formatCacheRate,
  formatTokens,
} from "./format"

export interface LogLineParts {
  prefix: string
  time: string
  method: string
  path: string
  model?: string
  /** Original model name from client (shown when different from resolved model) */
  clientModel?: string
  multiplier?: number
  status?: number
  duration?: string
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
    model,
    clientModel,
    multiplier,
    status,
    duration,
    requestBodySize,
    responseBodySize,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    queueWait,
    extra,
    retryableMeta,
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

  // Show "clientModel → model" only on a genuine remap. Suppress the arrow
  // when the client name and resolved name are the same model spelled
  // differently (e.g. "claude-opus-4-8" vs "claude-opus-4.8").
  let coloredModel = ""
  if (model) {
    coloredModel = clientModel && !isSameModelName(clientModel, model) ? ` ${pc.dim(clientModel)} → ${pc.magenta(model)}` : pc.magenta(` ${model}`)
  }
  const coloredMultiplier = pc.dim(formatBillingLabel(multiplier))
  const coloredDuration = duration ? ` ${pc.yellow(duration)}` : ""
  const coloredQueueWait = queueWait ? ` ${pc.dim(`(queued ${queueWait})`)}` : ""

  // req/resp body sizes with ↑↓ arrows
  let sizeInfo = ""
  if (model) {
    const reqSize = requestBodySize !== undefined ? `↑${formatBytes(requestBodySize)}` : ""
    const respSize = responseBodySize !== undefined ? `↓${formatBytes(responseBodySize)}` : ""
    const sizes = [reqSize, respSize].filter(Boolean).join(" ")
    if (sizes) sizeInfo = ` ${pc.dim(sizes)}`
  }

  // in-tokens/out-tokens (with cache breakdown)
  let tokenInfo = ""
  if (model && (inputTokens !== undefined || outputTokens !== undefined)) {
    tokenInfo = ` ${formatTokens(inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens)}`
  }

  // Prompt-cache rate marker (`↻<hit%>+<new%>`), following the token column.
  // Empty (suppressed) when there is no cache activity — see formatCacheRate.
  let cacheInfo = ""
  if (model) {
    const rate = formatCacheRate(inputTokens, cacheReadInputTokens, cacheCreationInputTokens)
    if (rate) cacheInfo = ` ${rate}`
  }

  let extraPart = ""
  if (extra) {
    // Retry lines reuse the same red coloring as [FAIL] for the error message.
    extraPart = isError || isRetry ? pc.red(extra) : extra
  }

  // Dim metadata (e.g. retry strategy info) appended after the error message.
  const retryableMetaPart = retryableMeta ? ` ${pc.dim(retryableMeta)}` : ""

  // Request id appended dim at the very end (only when provided, e.g. error lines) for history lookup.
  const reqIdPart = reqId ? ` ${pc.dim(reqId)}` : ""

  const statusAndMethod = coloredStatus ? `${coloredStatus} ${coloredMethod}` : coloredMethod

  return `${coloredPrefix} ${coloredTime} ${statusAndMethod} ${coloredPath}${coloredModel}${coloredMultiplier}${coloredDuration}${coloredQueueWait}${sizeInfo}${tokenInfo}${cacheInfo}${extraPart}${retryableMetaPart}${reqIdPart}`
}

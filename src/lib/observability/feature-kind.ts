/** Feature kinds — replaces the legacy `tags: string[]` escape hatch. */
export type FeatureKind =
  /**
   * Thinking mode as a per-request terminal dimension —
   * `detail: { requested?: string, effective: string }`. `effective` is the
   * final outbound wire `thinking.type` (post coerceAdaptiveThinking); `requested`
   * is the client's original `thinking.type`. They differ when the pipeline
   * coerced it (e.g. `enabled`→`adaptive`). Scope: top-level `thinking.type` only
   * (budget_tokens / output_config.effort coercions are not surfaced here).
   */
  | "thinking"
  /** unsupported-beta strategy stripped headers — `detail: { betas: string[] }` */
  | "beta-stripped"
  /** passthrough 剥掉 GHC 未支持的 cache_control 子字段（如 scope）— `detail: { fields: string[] }` */
  | "cache-control-stripped"
  /** responses → chat-completions fallback */
  | "via-chat-completions-fallback"
  /** chat-completions → responses (reverse fallback) */
  | "via-responses"
  /** sanitize dropped unsupported params — `detail: { params: string[] }` */
  | "dropped-params"
  /** request used a non-default transport — `detail: { kind: TransportKind }` */
  | "transport"
  /** downstream owner crossed its wire commit point before delivery failed */
  | "wire-partial-delivery"
  /** recoverer rebuilt tool_use(s) from downgraded upstream text — `detail: { tools: string[] }` (the recovered tool names, in call order) */
  | "tool-call-recovered"
  /** suppression mode: a contentless upstream refusal was rewritten into a normal completed turn so
   *  the client's conversation is not interrupted (the request still settles FAILED).
   *  `detail: { category: string }` uses the named upstream category or `uncategorized`. */
  | "refusal-recovered"
  /** error mode: surfaced a contentless upstream refusal as an `event: error` frame + ctx.fail.
   *  `detail: { category: string }` uses the named upstream category or `uncategorized`. */
  | "refusal-errored"
  /** passthrough mode: the genuine upstream refusal reached the client untouched (still settles FAILED).
   *  `detail: { category: string }` uses the named upstream category or `uncategorized`. */
  | "refusal-passthrough"
  /** error-shaping 决策命中 — detail: { decision: "retry-signal"|"ask-user-question"|"canonical-error"|"defer-to-block-level", errorType: ApiErrorType, commitPhase: "pre-commit"|"post-commit" } */
  | "error-shaping-decided"
  /** error-shaping B类 AskUserQuestion 合成命中 — detail: { errorType: ApiErrorType } */
  | "error-shaping-auq-synthesized"
  /** error-shaping D类自愈委派命中（策略被强制 canHandle=false）— detail: { strategyName: string } */
  | "error-shaping-selfheal-delegated"
  /** raw-stream canonical error 终点整形命中（H3 stream-error / truncation × direct/translate 腿）——
   * detail: { wireErrorType: string, terminus: "stream-error"|"truncation", leg: "direct"|"translate" }.
   * `wireErrorType` 是 wire 级字符串（非 error-shaping-decided 的 ApiErrorType 枚举——同名会混值域）。 */
  | "error-shaping-raw-canonical"
  /** a tool_use input field selected for decode couldn't be decoded — `detail: { tool, field?, reason }` */
  | "tool-input-decode-failed"
  /** L2 buffered-retry resolution — `detail: { outcome: "success"|"exhausted"|"retreated", retries: number }` */
  | "protect-streaming-retry"
  /** Streaming keepalive: proxy opened a 200 SSE stream on request receipt and started the connection-
   *  level heartbeat immediately, decoupled from the upstream. `detail: {}`. */
  | "stream-immediate-keepalive"
  /** Upstream resolved after the immediate keepalive commit — `detail: { totalStalledMs: number }`. */
  | "stream-upstream-resolved"
  /**
   * Upstream applied context_management edits — its authoritative receipt that our injected
   * `context_management` (context_editing / L2 escalation) actually cleared context.
   * `detail: { count: number, clearedInputTokens: number, types: string[] }`. Only recorded when
   * `applied_edits` is non-empty (an empty receipt means upstream cleared nothing).
   */
  | "context-edits-applied"
  /** a malformed tool_use input was repaired before forwarding — `detail: { tool, layer: "tags"|"repair" }` */
  | "tool-input-repaired"
  /** a malformed tool_use input could not be repaired (strip + jsonrepair both failed) — `detail: { tool }` */
  | "tool-input-unrepairable"
  /**
   * translation matrix: a forward-leg (anthropic→cc/responses) upstream choice finished with
   * `content_filter`, which has no Anthropic stop_reason and was mapped to `end_turn` on the client
   * wire (N3) — this marker keeps the degradation observably distinguishable (richest-data-flow). `detail: {}`.
   */
  | "translated-content-filter"
  /** reverse translation mapped an Anthropic refusal to a target protocol that cannot carry
   *  `stop_details.category`. `detail: { category, target: "openai-cc"|"openai-responses" }`. */
  | "translated-refusal-category-dropped"

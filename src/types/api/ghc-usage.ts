/**
 * GHC (GitHub Copilot) 对 OpenAI-format usage 的扩展字段，非 OpenAI 标准。
 *
 * 我们的 chat-completions usage 类型来自 `openai` SDK 的 `CompletionUsage`，其
 * `PromptTokensDetails` 只声明 `audio_tokens`/`cached_tokens`，看不见 GHC 新增的
 * `cache_write_tokens` 与模态/prediction 分解。故在此自有定义、**不** module-augment
 * SDK 类型（SSOT：GHC 扩展的拥有方是本项目，不是 OpenAI SDK）。
 *
 * 见 `docs/spec/2026-07-12-ghc-usage-details.md` §4。
 */

/** chat/completions 帧的 `prompt_tokens_details`（GHC 扩展；cache_write 在此）。 */
export interface GhcPromptTokensDetails {
  cached_tokens?: number | null
  cache_write_tokens?: number | null
  text_tokens?: number | null
  audio_tokens?: number | null
  image_tokens?: number | null
  video_tokens?: number | null
}

/** chat/completions 帧的 `completion_tokens_details`（GHC 扩展）。 */
export interface GhcCompletionTokensDetails {
  reasoning_tokens?: number | null
  text_tokens?: number | null
  audio_tokens?: number | null
  image_tokens?: number | null
  video_tokens?: number | null
  accepted_prediction_tokens?: number | null
  rejected_prediction_tokens?: number | null
}

/**
 * responses 帧的 `input_tokens_details`（GHC 扩展；cache_write 在这里而非
 * `prompt_tokens_details` —— 见 spec §5.2 M3 字段位置分歧）。
 */
export interface GhcInputTokensDetails {
  cached_tokens?: number | null
  cache_write_tokens?: number | null
  text_tokens?: number | null
  audio_tokens?: number | null
  image_tokens?: number | null
  video_tokens?: number | null
}

/**
 * 归一化非空整数：`null` / `undefined` / `NaN` / 负数 → `undefined`；否则该数。
 * 用于「非空才挂」——GHC 的模态字段常为 `null`（文本类模型），不应落进 usage。
 */
export function nonNegOrUndef(v: number | null | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined
}

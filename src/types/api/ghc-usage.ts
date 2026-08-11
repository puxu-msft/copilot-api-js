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

/**
 * 把 GHC 的 prompt/input details（`*_tokens` 后缀）映射为 canonical `input_tokens_details`
 * 形状（无后缀）。空值剔除交由 `usageFromTotalInput` 的 pruneEmpty。
 */
export function mapInputDetails(d: GhcPromptTokensDetails | GhcInputTokensDetails | undefined): {
  text?: number
  audio?: number
  image?: number
  video?: number
} {
  return {
    text: nonNegOrUndef(d?.text_tokens),
    audio: nonNegOrUndef(d?.audio_tokens),
    image: nonNegOrUndef(d?.image_tokens),
    video: nonNegOrUndef(d?.video_tokens),
  }
}

/** 把 GHC 的 completion details 映射为 canonical `output_tokens_details` 的模态/prediction 部分（reasoning 由调用方另传）。 */
export function mapOutputDetails(d: GhcCompletionTokensDetails | undefined): {
  text?: number
  audio?: number
  image?: number
  video?: number
  accepted_prediction_tokens?: number
  rejected_prediction_tokens?: number
} {
  return {
    text: nonNegOrUndef(d?.text_tokens),
    audio: nonNegOrUndef(d?.audio_tokens),
    image: nonNegOrUndef(d?.image_tokens),
    video: nonNegOrUndef(d?.video_tokens),
    accepted_prediction_tokens: nonNegOrUndef(d?.accepted_prediction_tokens),
    rejected_prediction_tokens: nonNegOrUndef(d?.rejected_prediction_tokens),
  }
}

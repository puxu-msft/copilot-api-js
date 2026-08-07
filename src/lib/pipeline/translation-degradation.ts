/** Request-side Anthropic→Responses degradation when Anthropic thinking state cannot cross model families. */
export interface AnthropicToResponsesTranslationDegradation {
  droppedThinkingBlockCount: number
  sourceSignedThinkingBlockCount: number
  unsignedThinkingBlockCount: number
  reason: "thinking-signature-not-portable"
}

export type AnthropicToResponsesTranslationDegradationReporter = (degradation: AnthropicToResponsesTranslationDegradation) => void

/**
 * Gemini conversion barrel.
 */

// Request conversion
export { convertGeminiRequestToOpenAI, type ConvertRequestOptions } from "./convert-request"

// Response conversion
export {
  convertOpenAIResponseToGemini,
  extractUsageMetadata,
  //
  type GeminiUsageMetadata,
  messageToParts,
  openAIFinishToGemini,
} from "./convert-response"

// Streaming
export {
  //
  type GeminiStreamMeta,
  type GeminiStreamStep,
  translateOpenAIStreamToGemini,
} from "./convert-stream"

// Schema normalization
export { normalizeSchemaTypes } from "./schema-normalize"

// Tool-call pairing
export {
  //
  type CallIdMap,
  pairFunctionCalls,
  type PairingResult,
  resolveCallId,
  resolveResponseId,
  SYNTHETIC_CALL_ID_PREFIX,
} from "./tool-call-pairing"

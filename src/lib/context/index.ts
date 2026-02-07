/**
 * Context module — RequestContext + GlobalContext + Manager
 *
 * Re-exports all context-related types and factories.
 */

// GlobalContext
export type { GlobalContext } from "./global"
export { createGlobalContext } from "./global"

// RequestContextManager
export type { RequestContextEvent, RequestContextManager } from "./manager"
export { createRequestContextManager } from "./manager"

// RequestContext
export type {
  Attempt,
  EffectiveRequest,
  HistoryEntryData,
  OriginalRequest,
  RequestContext,
  RequestContextEventCallback,
  RequestContextEventData,
  RequestState,
  ResponseData,
  RewriteMapping,
  SanitizationState,
  StreamAccumulatorResult,
  TranslationState,
  TruncationState,
} from "./request"
export { createRequestContext } from "./request"

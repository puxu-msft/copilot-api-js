// ============================================================================
// Web search (double-hop) — barrel re-export
// ============================================================================

// Backends
export {
  //
  executeWebSearch,
  formatSearchResultsText,
  parseSearchResults,
  parseWebSearchBackend,
  SEARCH_RESULT_LIMIT,
  type SearchExecutionResult,
  type SearchResult,
  type WebSearchBackend,
} from "./backends"

// Detection
export {
  //
  isWebSearchTool,
  payloadHasWebSearch,
} from "./detect"

// Orchestration
export {
  //
  orchestrateWebSearch,
  type OrchestrateWebSearchArgs,
  type WebSearchOrchestrationResult,
} from "./orchestrator"

// Synthesis
export {
  //
  buildWebSearchResponse,
  type SynthesizedUsage,
  webSearchResponseToEvents,
} from "./synthesize"

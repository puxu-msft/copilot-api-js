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
  completeWebSearch,
  orchestrateWebSearch,
  type OrchestrateWebSearchArgs,
  runFirstHopProbe,
  type WebSearchOrchestrationResult,
  type WebSearchProbeResult,
} from "./orchestrator"

// Synthesis
export {
  //
  buildWebSearchResponse,
  type SynthesizedUsage,
  webSearchResponseToEvents,
} from "./synthesize"

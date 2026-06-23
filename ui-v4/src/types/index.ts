// 单一真实来源：核心类型从后端 re-export(spec §2)。
// 实证 src/lib/history/store.ts —— 下列名均由 store barrel 导出。
export type {
  ContentBlock,
  CursorResult,
  EndpointType,
  EntrySummary,
  HistoryEntry,
  HistoryStats,
  QueryOptions,
  RequestLifecycleState,
  SessionSummary,
  SseEventRecord,
  SummaryResult,
  SystemBlock,
} from "~backend/lib/history/store"

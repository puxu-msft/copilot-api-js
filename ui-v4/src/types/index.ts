// 反应式学习记录（SSOT：后端 feature-negotiation.ts + negotiation-lifecycle.ts）
export type { LearnedEntryView, LearnedSnapshot } from "~backend/lib/anthropic/feature-negotiation"

export type { EntryStatus, NegotiationCategory } from "~backend/lib/anthropic/negotiation-lifecycle"
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
  UsageData,
} from "~backend/lib/history/store"

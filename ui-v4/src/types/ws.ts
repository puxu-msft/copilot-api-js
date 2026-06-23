// WS 消息判别联合(前端专有)。ActiveRequestInfo 是 wire 类型,后端当前未导出为公开 type;
// TODO(Plan 05): 后端导出后改为从 ~backend re-export(single-source)。
import type {
  //
  EntrySummary,
  HistoryStats,
} from "@/types"

export interface ActiveRequestInfo {
  id: string
  endpoint: string
  rawPath?: string
  state: string
  startTime: number
  durationMs: number
  model?: string
  stream?: boolean
  attemptCount?: number
  currentStrategy?: string
  queueWaitMs?: number
}

export interface ActiveRequestChangedInfo {
  action: "created" | "state_changed" | "completed" | "failed"
  request?: ActiveRequestInfo
  requestId?: string
  activeCount: number
}

export interface ConnectedInfo {
  clientCount: number
  activeRequests: Array<ActiveRequestInfo>
}

interface WsEnvelope<TType extends string, TData> {
  type: TType
  data: TData
  timestamp: number
}

export type WsMessage =
  | WsEnvelope<"connected", ConnectedInfo>
  | WsEnvelope<"active_request_changed", ActiveRequestChangedInfo>
  | WsEnvelope<"entry_added", EntrySummary>
  | WsEnvelope<"entry_updated", EntrySummary>
  | WsEnvelope<"stats_updated", HistoryStats>

/**
 * 守卫入参:未判别前的原始 WS 信封(`data` 为 unknown,待 type guard 收窄)。
 * 每个 `WsMessage` 变体都是它的子类型,故 type predicate 的目标类型合法可赋。
 */
export interface RawWsMessage {
  type?: string
  data?: unknown
  timestamp?: number
}

export function isConnected(m: RawWsMessage): m is WsEnvelope<"connected", ConnectedInfo> {
  return m.type === "connected"
}
export function isActiveRequestChanged(m: RawWsMessage): m is WsEnvelope<"active_request_changed", ActiveRequestChangedInfo> {
  return m.type === "active_request_changed"
}
export function isEntryAdded(m: RawWsMessage): m is WsEnvelope<"entry_added", EntrySummary> {
  return m.type === "entry_added"
}
export function isEntryUpdated(m: RawWsMessage): m is WsEnvelope<"entry_updated", EntrySummary> {
  return m.type === "entry_updated"
}

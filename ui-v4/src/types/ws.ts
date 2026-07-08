// active-request wire 类型的单一事实源在后端(SSOT)。前端 type-only re-export——
// isolatedModules 下 import type 被完全擦除,不把后端运行时(activity-summary→state)拖进 bundle。
// 验收必跑 `bun run build:ui-v4`(typecheck/vitest 对误拖入双假绿)。
export type {
  //
  ActiveRequestChangedWire as ActiveRequestChangedInfo,
  ActiveRequestWire as ActiveRequestInfo,
} from "~backend/lib/observability/active-request-wire"

import type {
  //
  EntrySummary,
  HistoryStats,
} from "@/types"
import type { ActiveRequestInfo } from "@/types/ws"

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

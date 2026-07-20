// active-request 的 WS wire 类型单一事实源(SSOT)。
// 纯 types-only + 无状态映射:绝不 import `~/lib/state`,以便前端可 `import type` 安全 re-export
// (值导入被 isolatedModules 擦除;若误引入运行时依赖,build:ui-v4 会炸)。
import type { RequestActivitySnapshot } from "~/lib/context/activity-summary"
import type { RequestState } from "~/lib/context/types"
import type { EndpointType } from "~/lib/history/types"
import type {
  //
  AttemptSnapshot,
  FeatureKind,
  RequestContextSnapshot,
} from "~/lib/observability/events"

/**
 * 单个在途请求的 wire 形状 —— `RequestActivitySnapshot` 全字段(state/durationMs/attemptCount/
 * currentStrategy/queueWaitMs/transport/stream/model/active/lastUpdatedAt…)叠加 requestPayload
 * 侧的顶层富字段。所有非 summarize 字段设为可选,兼容 summary 缺失的防御降级。
 */
export interface ActiveRequestWire extends Partial<RequestActivitySnapshot> {
  id: string
  // endpoint/state 保持精确 union(EndpointType/RequestState),与 Partial<RequestActivitySnapshot>
  // 同型不 widen —— 前端 re-export 拿到可判别的精确类型,不丢信息。
  endpoint: EndpointType
  state: RequestState
  startTime: number
  // 顶层富字段(不在 RequestActivitySnapshot 里,来自 RequestContextSnapshot)
  sessionId?: string
  method?: string
  path?: string
  clientModel?: string
  resolvedModel?: string
  requestBodySize?: number
  multiplier?: number
}

/** attempt_failed 的实时重试遥测(对齐 sinks/ws.ts 的 payload)。 */
export interface AttemptFailedWire {
  action: "attempt_failed"
  requestId: string
  attempt: number
  strategy?: string
  willRetry: boolean
  nextStrategy?: string
  waitMs: number
  learning?: boolean
  error?: AttemptSnapshot["error"]
}

/** feature_applied 的特性遥测。 */
export interface FeatureAppliedWire {
  action: "feature_applied"
  requestId: string
  feature: FeatureKind
  detail?: Record<string, unknown>
}

/** active_request_changed 事件的判别联合(逐 action 建模,消除 `data: unknown`)。 */
export type ActiveRequestChangedWire =
  | { action: "created" | "state_changed"; request: ActiveRequestWire; activeCount: number }
  | { action: "completed" | "failed" | "aborted"; requestId: string; activeCount: number }
  | AttemptFailedWire
  | FeatureAppliedWire

/** connected 事件的在途快照数组元素类型即 ActiveRequestWire。 */
export interface ConnectedActiveRequests {
  clientCount: number
  activeRequests: Array<ActiveRequestWire>
}

/**
 * 快照 → wire 的唯一映射(纯函数,无状态)。connected 工厂与 sinks/ws.ts 的 requestPayload
 * 都经它,保证两条路径逐字段同构。summary 存在时取其标量,并叠加顶层富字段。
 */
export function toActiveRequestWire(snap: RequestContextSnapshot): ActiveRequestWire {
  const s = snap.summary
  return {
    // summary 标量(缺失时降级到快照顶层可得字段)
    ...s,
    id: snap.id,
    endpoint: snap.endpoint,
    state: snap.state,
    startTime: snap.startTime,
    // queueWaitMs 在快照顶层永远可得(非可选 number),summary 缺失时无损降级
    queueWaitMs: snap.queueWaitMs,
    // 顶层富字段(requestPayload 当前漏 requestBodySize/multiplier)
    method: snap.method,
    path: snap.path,
    ...(snap.sessionId !== undefined && { sessionId: snap.sessionId }),
    ...(snap.rawPath !== undefined && { rawPath: snap.rawPath }),
    ...(snap.clientModel !== undefined && { clientModel: snap.clientModel }),
    ...(snap.resolvedModel !== undefined && { resolvedModel: snap.resolvedModel }),
    ...(snap.requestBodySize !== undefined && { requestBodySize: snap.requestBodySize }),
    ...(snap.multiplier !== undefined && { multiplier: snap.multiplier }),
  }
}

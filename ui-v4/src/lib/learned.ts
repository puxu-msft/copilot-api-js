import type {
  //
  EntryStatus,
  NegotiationCategory,
} from "@/types"

/** 10 个功能分组的中文名（面向用户）。 */
export const CATEGORY_LABELS: Record<NegotiationCategory, string> = {
  features: "请求体字段（Extra inputs）",
  betas: "anthropic-beta 头",
  efforts: "reasoning effort 白名单",
  effortUnsupported: "不支持 effort 的模型",
  deferredTools: "强制不 defer 的工具",
  serverTools: "不支持的原生 server tool",
  partnerFeatures: "被禁的 partner 特性",
  systemRejectModels: "拒 role:system 的模型",
  serverToolDowngrade: "需降级 prior-turn server-tool 的模型",
  toolFields: "不支持的 custom-tool 字段（endpoint 级）",
}

/** 合并 expired 与 manually_expired 为同一「已过期」徽章（后端仍区分四态）。 */
export function badgeKind(status: EntryStatus): "active" | "expired" | "pinned" {
  if (status === "pinned") return "pinned"
  if (status === "active") return "active"
  return "expired" // expired | manually_expired
}

/**
 * 面向用户展示的值。`systemRejectModels` / `serverToolDowngrade` 的 value 是 endpoint 级
 * 的 modelKey（形如 `https://…|anthropic-messages|<model>`），非裸模型名；效率类
 * （efforts / effortUnsupported）则本就是裸模型名。凡含 endpoint 标记 `|anthropic-messages|`
 * 的值，只展示最后一段（裸模型），其余原样。原始 value 仍用于 action ref 的往返（不可用此投影）。
 */
export function displayValue(_category: NegotiationCategory, value: string): string {
  if (value.includes("|anthropic-messages|")) {
    const idx = value.lastIndexOf("|")
    return value.slice(idx + 1)
  }
  return value
}

export function relativeTime(ms: number, now: number = Date.now()): string {
  const diff = now - ms
  if (diff < 60_000) return "刚刚"
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

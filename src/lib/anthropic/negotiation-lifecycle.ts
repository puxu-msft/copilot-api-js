/**
 * 反应式学习记录的生命周期 primitive（单一过期判据）。
 *
 * 无副作用、不改内存缓存 —— 纯函数 + 读 state 的 TTL 配置。所有消费点经
 * `isEntryActive` 判定过期，不各自判。`categoryTtlMs` 读运行时 config（hot-reload）。
 */
import { state } from "~/lib/state"

export interface LearnedEntryMeta {
  /** 首次学到（epoch ms）。migrated 记录为迁移时刻，非真实首学。 */
  firstLearnedAt: number
  /** 最后确认（epoch ms）。上游再拒 / 用户续约时刷新 —— TTL 基准。 */
  lastConfirmedAt: number
  /** true = 永不过期（无视 TTL / manuallyExpired）。 */
  pinned?: boolean
  /** 立即失效：强制过期但保留行；再确认 / 续约时清除。 */
  manuallyExpired?: boolean
  /** 由 v1 永久记录迁移而来 —— firstLearnedAt 非真实首学时刻。 */
  migrated?: boolean
}

export type NegotiationCategory =
  | "features"
  | "betas"
  | "efforts"
  | "effortUnsupported"
  | "deferredTools"
  | "serverTools"
  | "partnerFeatures"
  | "systemRejectModels"
  | "serverToolDowngrade"
  | "toolFields"

/** 全部 10 个分类 —— 遍历 / 穷尽用。顺序即 UI/快照展示顺序。 */
export const NEGOTIATION_CATEGORIES: ReadonlyArray<NegotiationCategory> = [
  "features",
  "betas",
  "efforts",
  "effortUnsupported",
  "deferredTools",
  "serverTools",
  "partnerFeatures",
  "systemRejectModels",
  "serverToolDowngrade",
  "toolFields",
]

export type EntryStatus = "active" | "expired" | "pinned" | "manually_expired"

export function nowMs(): number {
  return Date.now()
}

/**
 * 分类的 TTL（ms）。读 state 的 negotiation 配置切片：per-category 覆盖优先，
 * 否则默认。`Number.POSITIVE_INFINITY` = never（不自动过期）。
 */
export function categoryTtlMs(category: NegotiationCategory): number {
  const overrides = state.negotiationTtlOverridesMs
  if (category in overrides) return overrides[category]
  return state.negotiationDefaultTtlMs
}

export function isEntryActive(meta: LearnedEntryMeta, category: NegotiationCategory, now: number): boolean {
  if (meta.pinned) return true
  if (meta.manuallyExpired) return false
  const ttl = categoryTtlMs(category)
  if (ttl === Number.POSITIVE_INFINITY) return true
  return now <= meta.lastConfirmedAt + ttl
}

export function entryStatus(meta: LearnedEntryMeta, category: NegotiationCategory, now: number): EntryStatus {
  if (meta.pinned) return "pinned"
  if (meta.manuallyExpired) return "manually_expired"
  return isEntryActive(meta, category, now) ? "active" : "expired"
}

/** 派生过期时刻（epoch ms）；pin 或 never → null（不适用）。 */
export function entryExpiresAt(meta: LearnedEntryMeta, category: NegotiationCategory): number | null {
  if (meta.pinned) return null
  const ttl = categoryTtlMs(category)
  if (ttl === Number.POSITIVE_INFINITY) return null
  return meta.lastConfirmedAt + ttl
}

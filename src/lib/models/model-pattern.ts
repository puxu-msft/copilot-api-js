/**
 * 通用「模型名 × 模式」匹配 primitive。承载 glob 编译（纯）、glob vs 精确分派、
 * 能力列表的「positive 命中且 negative 未命中」求值，以及 per-model map 键匹配。
 *
 * 归属 `models/` 而非 `anthropic/`：它是模型名语义、被 `anthropic/features.ts`、
 * `anthropic/per-model-config.ts`、`anthropic/header-policy/header-glob-strip.ts` 与
 * `models/timeout-resolver.ts` 多方消费；放 anthropic 子树会造成 models→anthropic 反向依赖。
 *
 * 语义权威见 docs/spec/2026-07-23-model-capabilities-glob-and-negation.md。
 */

import { normalizeForMatching } from "./model-name"

/** 模式是否含 glob 元字符（`*` / `?`）。 */
export function hasGlobMeta(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?")
}

/**
 * 把 glob（`*` `?`）编译成锚定、大小写不敏感的 RegExp。**纯编译**——不做任何归一化，
 * 调用方（model 侧包装器）负责先 `normalizeForMatching`；header 侧复用时保持字面语义。
 * 迁移自 header-glob-strip.ts，行为逐字节保持。
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replaceAll(/[.+^${}()|[\]\\]/gu, String.raw`\$&`)
    .replaceAll("*", ".*")
    .replaceAll("?", ".")
  return new RegExp(`^${escaped}$`, "iu")
}

/**
 * 单模式对单候选：先对两侧归一，再按是否含元字符分派——
 * 含 `*`/`?` → 锚定 glob；否则 → **精确匹配**（`n === np`）。
 *
 * family 覆盖（覆盖「一整代 Claude」）一律用显式 glob 表达，如 `claude-opus-4*` 或
 * `claude-opus-4-*`。旧版的隐式 family-前缀（`n.startsWith(np + "-")`）已退役：glob 落地后
 * 它是冗余且隐晦的第二条覆盖路径，去掉后 glob-free token 语义收敛为单一、可预测的精确匹配。
 */
export function matchesModelPattern(candidate: string, pattern: string): boolean {
  const n = normalizeForMatching(candidate)
  const np = normalizeForMatching(pattern)
  if (hasGlobMeta(np)) return globToRegExp(np).test(n)
  return n === np
}

/**
 * 能力列表求值：列表自洽 + 剔除永远胜（顺序无关）。`!` 前缀 = negative，其余 = positive。
 * 候选集 `[id, family?]`。返回 true 当且仅当：命中 ≥1 positive 且 命中 0 negative。
 * 空列表 / 只有 negative → false。
 */
export function modelMatchesPatternList(id: string, entries: ReadonlyArray<string>, family?: string): boolean {
  // Truthiness (not `!== undefined`) mirrors the legacy `matchModelCapability` candidate set: an
  // empty-string family is ignored, so `modelMatchesPatternList(id, ["*"], "")` stays false like before.
  const candidates = family ? [id, family] : [id]
  const hit = (pattern: string) => candidates.some((c) => matchesModelPattern(c, pattern))

  let matchedPositive = false
  for (const entry of entries) {
    if (entry.startsWith("!")) {
      if (hit(entry.slice(1))) return false // 任一候选命中任一 negative → 立即剔除
    } else if (hit(entry)) {
      matchedPositive = true
    }
  }
  return matchedPositive
}

/**
 * per-model map 键匹配：键含 `*`/`?` → 锚定 glob；否则 → substring `includes`（保持现状语义，
 * 绝不收窄成精确匹配）。两侧先归一。`"*"` 纯通配由调用方（per-model-config）特例处理、不进此函数。
 */
export function matchesModelKey(modelName: string, key: string): boolean {
  const n = normalizeForMatching(modelName)
  const nk = normalizeForMatching(key)
  if (hasGlobMeta(nk)) return globToRegExp(nk).test(n)
  return n.includes(nk)
}

/**
 * Return the value for the most-specific matching per-model key, falling back to
 * `"*"`. Literal keys outrank glob keys; within a kind, the longest key wins and
 * equal-length ties preserve insertion order.
 */
export function findMostSpecific<T>(modelName: string, patterns: Record<string, T>): T | undefined {
  let bestKey: string | undefined
  let bestIsGlob = false
  for (const key of Object.keys(patterns)) {
    if (key === "*") continue
    if (!matchesModelKey(modelName, key)) continue
    const isGlob = hasGlobMeta(key)
    const better = bestKey === undefined || (bestIsGlob && !isGlob) || (bestIsGlob === isGlob && key.length > bestKey.length)
    if (better) {
      bestKey = key
      bestIsGlob = isGlob
    }
  }
  if (bestKey !== undefined) return patterns[bestKey]
  if ("*" in patterns) return patterns["*"]
  return undefined
}

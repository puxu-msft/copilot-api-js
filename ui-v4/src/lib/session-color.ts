/** 一套分类色板：name（kebab）+ 中文风格 label + N 个 {base,shade} 配对 + 淡/强 tint alpha。 */
export interface SessionPalette {
  name: string
  label: string
  colors: ReadonlyArray<{ base: string; shade: string }>
  faintAlpha: number
  strongAlpha: number
}

/** 每行的 run 元信息（color/shade 已按当前色板解析；faint/strong tint 预算好供背景优先级取用）。 */
export interface RunInfo {
  color: string
  shade: string
  indent: boolean
  isRunStart: boolean
  isRunEnd: boolean
  faintTint: string
  strongTint: string
}

/** localStorage 键 —— 所选 session 色板名。 */
export const PALETTE_STORAGE_KEY = "ui-v4:requests:session-palette"

/**
 * 4 套精选分类色板（配色 subagent invoke dataviz skill 产出、官方 validator 实测）。
 * 全部锁冷色弧、与语义信号色（琥珀/绿/红粉）色相距 ≥33°、#141210 上可辨。
 * shade = OKLCH(L−0.10)，用于 subagent 从属色带。色值逐字取自 spec §4。
 */
export const SESSION_PALETTES: ReadonlyArray<SessionPalette> = [
  {
    name: "terminal-neon",
    label: "冷调霓虹（高饱和·分离度最佳·默认）",
    faintAlpha: 0.14,
    strongAlpha: 0.2,
    colors: [
      { base: "#00a39a", shade: "#00847c" },
      { base: "#009fb2", shade: "#008093" },
      { base: "#009bce", shade: "#007cad" },
      { base: "#2f9af2", shade: "#007bd0" },
      { base: "#4a78f9", shade: "#2f58d6" },
      { base: "#6f48f3", shade: "#561ed0" },
      { base: "#953cd1", shade: "#7710af" },
      { base: "#a442a8", shade: "#842089" },
      { base: "#ab448e", shade: "#8a2470" },
    ],
  },
  {
    name: "oceanic-jewel",
    label: "冷色宝石（深浓通透·与 amber 最和谐）",
    faintAlpha: 0.12,
    strongAlpha: 0.18,
    colors: [
      { base: "#00968b", shade: "#00786e" },
      { base: "#0093a5", shade: "#007586" },
      { base: "#008dc3", shade: "#006fa3" },
      { base: "#2569a8", shade: "#004c88" },
      { base: "#5874ea", shade: "#3e55c8" },
      { base: "#7746e0", shade: "#5c1fbe" },
      { base: "#a43ecf", shade: "#8513ae" },
      { base: "#b321a2", shade: "#910083" },
    ],
  },
  {
    name: "pastel-cool",
    label: "冷柔和（浅·低饱和·克制）",
    faintAlpha: 0.14,
    strongAlpha: 0.18,
    colors: [
      { base: "#28a6a0", shade: "#008782" },
      { base: "#2ea6ba", shade: "#00879b" },
      { base: "#449dc7", shade: "#1e7ea7" },
      { base: "#5d95d7", shade: "#3f76b6" },
      { base: "#7080dd", shade: "#5462bc" },
      { base: "#7f66b8", shade: "#634998" },
      { base: "#9360a3", shade: "#754384" },
      { base: "#a25b90", shade: "#823e72" },
    ],
  },
  {
    name: "slate-muted",
    label: "冷板岩柔和（低饱和·沉稳）",
    faintAlpha: 0.16,
    strongAlpha: 0.18,
    colors: [
      { base: "#27a6a3", shade: "#008785" },
      { base: "#2ca2b9", shade: "#00839a" },
      { base: "#2e83b0", shade: "#006591" },
      { base: "#3262a9", shade: "#154589" },
      { base: "#6c6fc8", shade: "#5151a7" },
      { base: "#9d81ce", shade: "#7f63ad" },
      { base: "#8c5798", shade: "#6e3b79" },
      { base: "#955584", shade: "#763967" },
    ],
  },
]

export const DEFAULT_PALETTE_NAME = "terminal-neon"

/** FNV-1a 32-bit（纯函数、无依赖）；稳定把 sessionId 映到色板槽。 */
function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.codePointAt(i) ?? 0
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 稳定 hash(sessionId) → 给定色板里索引一个 {base,shade}；无 sessionId → null。 */
export function sessionColor(sessionId: string | undefined, palette: SessionPalette): { base: string; shade: string } | null {
  if (!sessionId) return null
  const idx = hashString(sessionId) % palette.colors.length
  return palette.colors[idx]
}

/** 会话色 hex + alpha → rgba 背景串。 */
export function sessionTint(baseColor: string, alpha: number): string {
  const hex = baseColor.replace("#", "")
  const r = Number.parseInt(hex.slice(0, 2), 16)
  const g = Number.parseInt(hex.slice(2, 4), 16)
  const b = Number.parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * 相邻 run 边界预扫。跑在已加载全部页拼接的 rows 上（非虚拟化窗口），故不截断。
 * 无 sessionId 的行不入 map（调用方据此不铺色带/背景）。分页前沿末行 isRunEnd 暂定 true，
 * 翻页后 rows 变、本函数经 memo 重算收敛。
 */
export function computeSessionRuns(rows: ReadonlyArray<{ id: string; sessionId?: string; agentId?: string }>, palette: SessionPalette): Map<string, RunInfo> {
  const map = new Map<string, RunInfo>()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const pair = sessionColor(row.sessionId, palette)
    if (!pair) continue
    map.set(row.id, {
      color: pair.base,
      shade: pair.shade,
      indent: row.agentId !== undefined,
      isRunStart: i === 0 || rows[i - 1].sessionId !== row.sessionId,
      isRunEnd: i === rows.length - 1 || rows[i + 1].sessionId !== row.sessionId,
      faintTint: sessionTint(pair.base, palette.faintAlpha),
      strongTint: sessionTint(pair.base, palette.strongAlpha),
    })
  }
  return map
}

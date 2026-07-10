import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

/**
 * C1 守卫:中性语义 token 层 + 两 preset(amber/neutral)。
 *
 * 策略(§8.4 golden 思路 + verifying-authoritative-claims):
 * - 断言 token 家族齐全(`--content-*`/`--signal-*`/`--vendor-*`/`--surface-*`)+ 两 preset 块存在。
 * - **amber 等价性(INV-3 核心)**:amber preset 下关键语义 token 解析回**等价 amber 值**——
 *   独立 oracle = theme.css 的 `--color-*` 字面量(而非本文件自证);amber leg 引 `var(--color-*)`
 *   的 token 经 theme.css 解析后须命中 golden hex。
 * - **正样本证检查触达**:neutral preset 对同一批 token 的值须**不同于** amber(证映射真实存在、
 *   非复制粘贴;若两 preset 相同则守卫无效)。
 */

const stylesDir = resolve(import.meta.dirname, "../src/styles")
// C1 语义 token 层内联于 theme.css(而非独立 tokens.css):Tailwind v4 + shadcn 下相对 CSS
// @import 触发 Lightning CSS 构建失败,故内联;PRESET 标记块供本守卫解析。
const tokensCss = readFileSync(resolve(stylesDir, "theme.css"), "utf8")
const themeCss = tokensCss

/** 解析 theme.css `@theme{}` 里的 `--color-*: #hex` → map,作 amber 等价性的独立 oracle。 */
function parseColorTokens(css: string): Record<string, string> {
  const map: Record<string, string> = {}
  const re = /(--color-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) map[m[1]] = m[2].toLowerCase()
  return map
}

/** 定位含某注释标记的声明块(marker 置于 `{` 之后),返回 `{ ... }` 内文本(平衡花括号)。 */
function extractBlock(css: string, marker: string): string {
  const at = css.indexOf(marker)
  if (at === -1) throw new Error(`marker not found: ${marker}`)
  const open = css.lastIndexOf("{", at)
  if (open === -1) throw new Error(`no open brace before marker: ${marker}`)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++
    else if (css[i] === "}") {
      depth--
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  throw new Error(`unbalanced braces after marker: ${marker}`)
}

/** 从块文本解析 `--token: value;` 声明。 */
function parseDecls(block: string): Record<string, string> {
  const map: Record<string, string> = {}
  const re = /(--[a-z0-9-]+):([^;]+);/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) map[m[1]] = m[2].trim().toLowerCase()
  return map
}

/** 把 amber leg 的值(可能是 `var(--color-x)` 或字面量 hex)解析到最终 hex。 */
function resolveAmber(value: string, colorMap: Record<string, string>): string {
  const varMatch = value.match(/^var\((--color-[a-z0-9-]+)\)$/)
  if (varMatch) {
    const resolved = colorMap[varMatch[1]]
    if (!resolved) throw new Error(`amber leg references unknown ${varMatch[1]}`)
    return resolved
  }
  return value
}

const colorMap = parseColorTokens(themeCss)
const amber = parseDecls(extractBlock(tokensCss, "/*PRESET:amber*/"))
const neutral = parseDecls(extractBlock(tokensCss, "/*PRESET:neutral*/"))

describe("semantic token layer (C1)", () => {
  it("semantic token layer is inlined in theme.css (both PRESET blocks present)", () => {
    expect(themeCss).toContain("/*PRESET:amber*/")
    expect(themeCss).toContain("/*PRESET:neutral*/")
  })

  it("defines all four semantic token families with multiple shades", () => {
    for (const prefix of ["--content-", "--signal-", "--vendor-", "--surface-"]) {
      const inAmber = Object.keys(amber).filter((k) => k.startsWith(prefix))
      const inNeutral = Object.keys(neutral).filter((k) => k.startsWith(prefix))
      expect(inAmber.length, `${prefix} in amber preset`).toBeGreaterThan(1)
      // 两 preset 须映射同一批 token(名齐平)。
      expect(new Set(inNeutral)).toEqual(new Set(inAmber))
    }
  })

  it("has same-role multi-shade tokens (round2-B5): thinking x3, tool x2", () => {
    for (const t of ["--content-thinking", "--content-thinking-dim", "--content-thinking-accent", "--content-tool", "--content-tool-dim"]) {
      expect(amber, `amber preset defines ${t}`).toHaveProperty(t)
    }
  })

  it("has a --surface-* scale family (round2-B5, ~29 near-black hex home)", () => {
    const surfaces = Object.keys(amber).filter((k) => k.startsWith("--surface-"))
    // base/raised/overlay/sunken + 每独立 shade 一 token → 远多于 4。
    expect(surfaces.length).toBeGreaterThanOrEqual(20)
  })

  // amber 等价性 golden:独立 oracle = theme.css --color-* 字面量(经桥接)+ 全域实测 hex 字面量。
  // 值须与源码里被替换的字面量**逐字节相等**(#888 保持 #888,不写 #888888),保 C2/C3 像素等价。
  const AMBER_GOLDEN: Record<string, string> = {
    "--signal-ok": "#7fd99a",
    "--signal-fail": "#e08a8a",
    "--signal-warn": "#d4a04a",
    "--signal-muted": "#8a7a55",
    "--signal-live": "#d4a04a",
    "--vendor-anthropic": "#b48ead",
    "--vendor-openai": "#5aa2d0",
    "--vendor-google": "#8fbf7f",
    "--vendor-other": "#d08fb4",
    "--vendor-muted": "#8a7a55",
    "--content-thinking": "#a89ac0",
    "--content-thinking-dim": "#6a5a8a",
    "--content-thinking-accent": "#9a8ad0",
    "--content-tool": "#7fae7f",
    "--content-tool-dim": "#4a6a4a",
    "--content-add": "#7fd99a",
    "--content-del": "#e08a8a",
    "--content-muted": "#8a7a55",
    "--content-dim": "#888",
    "--content-text": "#d8cdbb",
    "--content-role-assistant": "#9ad",
    "--surface-base": "#141210",
    "--surface-raised": "#16161a",
    "--surface-border": "#2a2a32",
    "--surface-border-subtle": "#1e1e24",
    "--surface-code": "#100e0b",
    "--surface-active": "#3a2f1a",
    "--surface-input": "#0f0f12",
  }

  it("amber preset resolves each semantic token back to its equivalent amber value (INV-3)", () => {
    for (const [token, goldenHex] of Object.entries(AMBER_GOLDEN)) {
      expect(amber, `amber preset defines ${token}`).toHaveProperty(token)
      const resolved = resolveAmber(amber[token], colorMap)
      expect(resolved, `${token} amber-equivalent`).toBe(goldenHex.toLowerCase())
    }
  })

  // 正样本证检查触达:neutral preset 对 OQ-2 明确重映射的 token(grays/surfaces/accent/信号)
  // 须**不同于** amber(证映射真实存在、非复制粘贴)。vendor/语义色相(thinking 紫/tool 绿)
  // 跨 preset 可合法共享,不纳入本强断言。
  const NEUTRAL_DIFFERS = [
    "--signal-ok",
    "--signal-fail",
    "--content-add",
    "--content-del",
    "--content-dim",
    "--content-text",
    "--content-accent",
    "--surface-base",
    "--surface-raised",
    "--surface-border",
    "--surface-active",
    "--surface-code",
  ]

  it("neutral preset remaps the OQ-2 tokens to DIFFERENT values (positive control)", () => {
    for (const token of NEUTRAL_DIFFERS) {
      expect(amber, `amber preset defines ${token}`).toHaveProperty(token)
      expect(neutral, `neutral preset defines ${token}`).toHaveProperty(token)
      const amberResolved = resolveAmber(amber[token], colorMap)
      // neutral leg 不引 --color-*(那是 amber 命名空间),故直接比较字面量。
      expect(neutral[token], `${token} neutral must differ from amber`).not.toBe(amberResolved)
    }
  })

  it("neutral preset selector is scoped to the shadcn tree (extensible: 3rd preset = one block)", () => {
    expect(tokensCss).toMatch(/\[data-design="shadcn"\]/)
    expect(tokensCss).toMatch(/\[data-color-preset="neutral"\]/)
    // amber 默认挂 :root + amber-legacy,保证当前(data-design=amber-legacy)零视觉变化。
    expect(tokensCss).toMatch(/\[data-design="amber-legacy"\]/)
  })
})

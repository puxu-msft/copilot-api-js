import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

/**
 * C4 守卫:全局 amber 规则族作用域化到 `[data-design="amber-legacy"]`。
 *
 * round2-B8:`theme.css` 的全局 amber 规则**整族**(不止锐角)——`*{border-radius:0!important}`、
 * `.livedock-island` 2px 例外、`.toc-flash`(共享 `useAnchorScroll` 施加、泄漏进 shadcn 共享 B)、
 * `.rdp-amber`(day-picker 重映射)——在双树一挂时会污染 shadcn 树。C4 把它们作用域化,使
 * shadcn 树按 `--radius` token 出圆角、不出 amber 暖底。
 *
 * 策略(verifying-authoritative-claims,正样本证检查触达):
 * - **作用域化项**(border-radius / livedock / rdp-amber):断言规则均带 `[data-design="amber-legacy"]`
 *   前缀;并断言**未作用域化的全局形态已消失**(负控——若旧全局规则还在,守卫无效)。
 * - **box-sizing 保持全局**:布局基建(非 amber),shadcn 树也需要 → 拆出独立全局 `*` 规则,断言其
 *   仍无 data-design 前缀。
 * - **toc-flash 改用中性 token**(而非作用域化):`--surface-flash`/`--content-accent`(C1 已备,两 preset
 *   各映射)使**两树各得正确 flash**——amber-legacy 解析回 #2a2212 / amber primary(像素等价 INV-3),
 *   shadcn 解析到 slate/blue。断言 amber 字面量(#2a2212 / var(--color-primary))已从 toc-flash 消失、
 *   规则保持全局(两树共用)。
 * - **keyframes 保持全局**:drawer-slide-in / drawer-overlay-in 是纯 transform/opacity(无 amber 色),
 *   设计无关,shadcn drawer 可复用 → 不作用域化。断言其体内无 amber hex。
 */

const css = readFileSync(resolve(import.meta.dirname, "../src/styles/theme.css"), "utf8")

/** 提取以 `selectorNeedle` 开头的规则块的 `{...}` 内文本(第一处匹配,平衡花括号)。 */
function ruleBody(selectorNeedle: string): string {
  const at = css.indexOf(selectorNeedle)
  if (at === -1) throw new Error(`selector not found: ${selectorNeedle}`)
  const open = css.indexOf("{", at)
  if (open === -1) throw new Error(`no open brace after: ${selectorNeedle}`)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++
    else if (css[i] === "}") {
      depth--
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  throw new Error(`unbalanced braces after: ${selectorNeedle}`)
}

describe("C4: global amber rule family scoping", () => {
  it("scopes the global sharp-corner rule to [data-design=amber-legacy]", () => {
    // 作用域化后的锐角规则(通配符各带前缀)。
    expect(css).toMatch(
      /\[data-design="amber-legacy"\]\s*\*,\s*\[data-design="amber-legacy"\]\s*\*::before,\s*\[data-design="amber-legacy"\]\s*\*::after\s*\{\s*border-radius:\s*0\s*!important;\s*\}/,
    )
    // 负控:未作用域化的全局通配符 border-radius 规则已消失(证作用域化真的发生)。
    expect(css).not.toMatch(/(^|\n)\s*\*,\s*\*::before,\s*\*::after\s*\{[^}]*border-radius/)
  })

  it("keeps box-sizing global (layout infra, not amber; shadcn tree needs it too)", () => {
    expect(css).toMatch(/(^|\n)\s*\*,\s*\*::before,\s*\*::after\s*\{\s*box-sizing:\s*border-box;\s*\}/)
  })

  it("scopes the livedock 2px exception to [data-design=amber-legacy] (override chain intact)", () => {
    // 作用域化例外:[data-design][.livedock-island] 特异性(0,2,0) 仍压过作用域化锐角 [data-design][*] (0,1,0)。
    expect(css).toMatch(/\[data-design="amber-legacy"\]\s*\.livedock-island\s*\{\s*border-radius:\s*2px\s*!important;\s*\}/)
    // 负控:无未作用域化的 .livedock-island 规则。
    expect(css).not.toMatch(/(^|\n)\s*\.livedock-island\s*\{/)
  })

  it("scopes the .rdp-amber day-picker skin to [data-design=amber-legacy]", () => {
    expect(css).toMatch(/\[data-design="amber-legacy"\]\s*\.rdp-amber\s*\{/)
    expect(css).toMatch(/\[data-design="amber-legacy"\]\s*\.rdp-amber\s+\.rdp-day_button:hover\s*\{/)
    // 负控:无未作用域化的 .rdp-amber 规则。
    expect(css).not.toMatch(/(^|\n)\s*\.rdp-amber\s*(\.rdp-day_button:hover\s*)?\{/)
  })

  it("neutralizes .toc-flash to per-preset tokens (both trees get a correct flash)", () => {
    const body = ruleBody(".toc-flash {")
    // amber 字面量已消失(改中性 token)。
    expect(body).not.toContain("#2a2212")
    expect(body).not.toContain("var(--color-primary)")
    // 中性 token(C1 已备,amber-legacy 解析回等价 amber 值 → INV-3 像素等价)。
    expect(body).toContain("var(--surface-flash)")
    expect(body).toContain("var(--content-accent)")
    // toc-flash 保持全局(两树共用,各解析自己 preset 的 flash 底/强调)。
    expect(css).toMatch(/(^|\n)\.toc-flash\s*\{/)
  })

  it("keeps drawer keyframes global and amber-free (design-agnostic, reusable by shadcn drawer)", () => {
    for (const name of ["drawer-overlay-in", "drawer-slide-in"]) {
      const body = ruleBody(`@keyframes ${name}`)
      expect(body).not.toMatch(/#[0-9a-f]{3,8}/i)
      expect(body).not.toContain("--color-")
    }
    // keyframes 未作用域化(仍在全局 @keyframes,供两树复用)。
    expect(css).toMatch(/(^|\n)@keyframes\s+drawer-slide-in/)
  })
})

import {
  //
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs"
import {
  //
  join,
  relative,
  resolve,
} from "node:path"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

/**
 * B/A′/A 域 `designVersion` scope 守卫 + amber-reflow 守卫(逐页 P 阶段自动化不变量,P1 首建)。
 *
 * 把 Global Constraint 5/6 的人肉 grep 固化成源码守卫测试,后续每页天然复用。**关键设计:fail-closed**——
 * 两条守卫都**扫描全域、只排除已知合法者**(而非「白名单式枚举要扫的目录」)。逐页新增的 `*Shadcn.tsx` /
 * 新特性目录**天然被守卫覆盖**,永不需记得「把新目录加进扫描列表」(include-list = fail-open 盲区,
 * 与本项目 `fix-all-comparison-sites` / 类型系统前置逼出全站点的教训同构)。
 *
 *  - **designVersion scope**:`designVersion` 只允许出现在 D-shell / chrome / dock / fork 原语 /
 *    dialog seam(`components/shell/**`、`ui/AgnosticDialog`、`ui/HorizontalTabs`)+ 拥有方
 *    `stores/ui-store` + DOM 反射 `lib/data-design` + bootstrap `main.tsx`。**其余全 src 零命中**——
 *    逐页填 shadcn 侧时 designVersion 读取只下沉到 RoutePage 的 `DesignFork`,B/A 域(及任何新特性域)
 *    必须零 `designVersion` 标识符(含注释)。
 *  - **amber-reflow**:**中性面**(shadcn 侧页元素 `*Shadcn.tsx` + `shell/shadcn/**` + `ui/**` 原语 +
 *    C2/C3 中性化的共用 B 内容体 leaf)必须保持 preset-中性——只用语义 token(`--content-*`/`--signal-*`/
 *    `--surface-*`/`--vendor-*`)与中性 Tailwind class,绝不回流 amber 命名空间(`var(--color-*)`)或
 *    裸 amber hex(`[#rrggbb]`)。legacy 树在 Z1 前合法保留 amber,故不在中性面内、不被此守卫扫。
 *
 * verifying-authoritative-claims:两条守卫都跑**正样本**证扫描器真能命中目标——既证**单文件分支**
 *  (直接扫 `DesignFork.tsx` / `OverviewLegacy.tsx` 命中),又证**目录递归分支**(扫 `shell` / `overview`
 *  目录命中其中的 designVersion / amber 文件);二者走 `collectSources` 不同 code path,均需正样本护住。
 */

const uiRoot = resolve(import.meta.dirname, "..")
const srcRoot = resolve(uiRoot, "src")

/** 递归收集某目录(或单文件)下的 .ts/.tsx 源码文件绝对路径。 */
function collectSources(target: string): Array<string> {
  const out: Array<string> = []
  const walk = (p: string): void => {
    const st = statSync(p)
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name))
      return
    }
    if (/\.tsx?$/.test(p)) out.push(p)
  }
  walk(target)
  return out
}

/** 返回 target 下所有匹配 pattern 的 `relPath`(相对 srcRoot)列表(空 = 零命中)。 */
function filesMatching(target: string, pattern: RegExp): Array<string> {
  const hits: Array<string> = []
  for (const file of collectSources(resolve(srcRoot, target))) {
    pattern.lastIndex = 0
    if (pattern.test(readFileSync(file, "utf8"))) hits.push(relative(srcRoot, file))
  }
  return hits
}

const DESIGN_VERSION_RE = /\bdesignVersion\b/
// amber 命名空间(`var(--color-*)`)或裸十六进制 arbitrary value(`[#rrggbb]` / `[#rgb]`,
// 可带 class util 前缀如 `text-[#888]`)。语义 token `var(--content-*)` 不匹配。
const AMBER_HEX_RE = /var\(--color-|\[#[0-9a-fA-F]{3,8}\]/

// designVersion 合法者:D-shell/chrome/dock/fork 全域 + dialog seam + owner + DOM 反射 + bootstrap。
// 架构上有界且稳定;其余全 src(含所有特性/页目录)fail-closed 扫描。
const DESIGN_VERSION_ALLOWED_FILES: ReadonlySet<string> = new Set([
  "main.tsx", // bootstrap: startDataDesignSync
  "stores/ui-store.ts", // 拥有方:DesignVersion 类型 + designVersion 字段
  "lib/data-design.ts", // DOM 属性反射(模块级 store 订阅)
  "components/ui/AgnosticDialog.tsx", // dialog seam(P4 加真 fork;当前 docstring 提及)
  "components/ui/HorizontalTabs.tsx", // 抽屉/整页 chrome seam(docstring 提及「no designVersion」)
])
const isDesignVersionAllowed = (rel: string): boolean => DESIGN_VERSION_ALLOWED_FILES.has(rel) || rel.startsWith("components/shell/")

// 共用 B 内容体 leaf(C2/C3 中性化、两树共用)——中性面的一部分。**只列已中性化的内容体**,
// 不含 legacy D-shell 页壳(JsonToolsPage/LearnedPage 等仍合法持 amber,Z1 才删)。
const B_CONTENT_LEAVES = [
  "components/overview/StatCard.tsx",
  "components/tools/JsonTreeView.tsx",
  "components/common/RawJsonView.tsx",
  "components/learned/LearnedRow.tsx",
  "components/learned/StatusBadge.tsx",
  "components/sessions/SessionRow.tsx",
  "components/sessions/AgentLane.tsx",
  "components/requests/RequestRow.tsx",
  "components/detail/DiagnosticBar.tsx",
  "components/detail/segments", // 7 段内容体目录
  "components/models/detail-tabs", // 6 tab 内容体目录
] as const

/** 中性面文件集合(fail-closed):所有 `*Shadcn.tsx` + `shell/shadcn/**` + `ui/**` 原语 + 显式 B leaf。 */
function collectNeutralSurface(): Array<string> {
  const set = new Set<string>()
  for (const file of collectSources(srcRoot)) {
    const rel = relative(srcRoot, file)
    if (rel.endsWith("Shadcn.tsx") || rel.startsWith("components/shell/shadcn/") || rel.startsWith("components/ui/")) set.add(rel)
  }
  for (const leaf of B_CONTENT_LEAVES) {
    for (const file of collectSources(resolve(srcRoot, leaf))) set.add(relative(srcRoot, file))
  }
  return [...set]
}

describe("designVersion scope guard (fail-closed: whole src minus D-shell/seam)", () => {
  it("positive control (single-file branch): flags designVersion in shell/DesignFork.tsx", () => {
    expect(filesMatching("components/shell/DesignFork.tsx", DESIGN_VERSION_RE)).toEqual(["components/shell/DesignFork.tsx"])
  })

  it("positive control (directory branch): flags designVersion under components/shell/", () => {
    // 目录递归分支(与下方负向断言同 code path)——扫 shell 目录须命中 DesignFork.tsx。
    expect(filesMatching("components/shell", DESIGN_VERSION_RE)).toContain("components/shell/DesignFork.tsx")
  })

  it("no designVersion anywhere in src except the architecturally-bounded readers", () => {
    const hits = filesMatching(".", DESIGN_VERSION_RE).filter((rel) => !isDesignVersionAllowed(rel))
    expect(hits, `designVersion leaked outside D-shell/seam allowlist: ${hits.join(", ")}`).toEqual([])
  })
})

describe("amber-reflow guard (fail-closed: shadcn/neutral surface stays preset-neutral)", () => {
  it("positive control (single-file branch): flags raw amber hex in overview/OverviewLegacy.tsx", () => {
    // OverviewLegacy 是 legacy D-shell(合法持裸 amber hex,如 text-[#888])——证 amber 正则触达。
    expect(filesMatching("components/overview/OverviewLegacy.tsx", AMBER_HEX_RE)).toEqual(["components/overview/OverviewLegacy.tsx"])
  })

  it("positive control (directory branch): flags amber hex under components/overview/ (legacy only)", () => {
    // 目录扫 overview:命中 legacy(OverviewLegacy),不命中中性面(OverviewShadcn/StatCard)——证方向。
    const hits = filesMatching("components/overview", AMBER_HEX_RE)
    expect(hits).toContain("components/overview/OverviewLegacy.tsx")
    expect(hits).not.toContain("components/overview/OverviewShadcn.tsx")
  })

  it("neutral surface references no amber-namespace or raw hex colors", () => {
    const hits: Array<string> = []
    for (const rel of collectNeutralSurface()) {
      AMBER_HEX_RE.lastIndex = 0
      if (AMBER_HEX_RE.test(readFileSync(resolve(srcRoot, rel), "utf8"))) hits.push(rel)
    }
    expect(hits, `amber color reflowed into shadcn/neutral surface: ${hits.join(", ")}`).toEqual([])
  })
})

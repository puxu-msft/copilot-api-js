/**
 * L1 design-doc tree guard (Round 1–4 subagent 讨论结论).
 *
 * `docs/DESIGN.md` 的「核心模块」已从逐文件叶子树降级为目录级关系图——叶子清单是
 * 高 churn + 低密度 + 可机械派生的结构性负债,交 `git ls-files` / codemap 派生。本测试
 * 守护剩下的**人写关系层**:DESIGN.md 全文里每个 rooted 于 `src/` `tests/` `ui/` 的路径
 * 引用必须对应仓库真实存在的文件/目录,挡住「DESIGN.md 提到一个已删/已改名的路径」这类
 * 死条目复发(会让 Agent 读空 → 地图价值归负)。
 *
 * 实例(本轮审计抓到的):`context/consumers.ts`、`openai/client.ts`(已改名)、整目录
 * `tui/`(已删)、顶层 `system-prompt.ts`/`error.ts`(已变子目录)——降级 + 本守卫后均挡死。
 *
 * 设计(对照 DESIGN.md 真实路径形态):
 *  - 只断言**含 `/` 且 rooted 于 src/ tests/ ui/** 的路径(裸文件名如 `route.ts` 无目录锚点、
 *    不可解析,跳过;`docs/` markdown 链接不强求,scope 外)。
 *  - 先剥离 URL(`https://.../src/lib/x.ts` 不应误抓)。
 *  - 容忍 `*` glob(退化为前缀目录存在)与 trailing-slash 目录(statSync isDirectory)。
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import {
  //
  existsSync,
  readFileSync,
  statSync,
} from "node:fs"
import {
  //
  join,
  resolve,
} from "node:path"

/** 仓库根 = 本测试文件向上两级 (tests/infra → repo root). */
const REPO_ROOT = resolve(import.meta.dir, "..", "..")
const DESIGN_MD = join(REPO_ROOT, "docs", "DESIGN.md")

/** 从 DESIGN.md 提取所有 rooted-于-src/tests/ui 的路径引用(去重). */
function extractRootedPaths(markdown: string): Array<string> {
  // 先剥离 URL,避免误抓 https://host/src/lib/x.ts 里的路径段.
  const noUrls = markdown.replaceAll(/https?:\/\/\S+/g, "")
  // rooted: 以 src/|tests/|ui/ 开头,含 [A-Za-z0-9_./*-];结尾标点由下方 clean 去掉.
  const raw = noUrls.match(/(?:^|[^\w./-])(?:src|tests|ui)\/[\w./*-]+/g) ?? []
  const cleaned = raw
    .map((m) => m.replace(/^[^\w./-]/, "")) // 去掉前导分隔符(正则的非路径首字符)
    .map((p) => p.replace(/[.,;:)、，。]+$/, "")) // 去掉中英句尾标点
    .filter((p) => p !== "src/" && p !== "tests/" && p !== "ui/") // 裸前缀不算
    // `node_modules/` 下的引用是**安装产物**不是源码。它是 gitignored 的，一个刚 `git worktree add`
    // 出来的干净树里天然没有，于是这条守卫会稳定报一个与文档正确性无关的死条目——环境性的红最容易
    // 被当成「既有失败」挥手放过，进而掩盖真的死条目。守卫要盯的是「DESIGN.md 指向了不存在的**源码**」，
    // 装没装依赖不在它的职责里（同型处置见 CLAUDE.md 的 history-search native 产物 skipIf 约定）。
    .filter((p) => !p.split("/").includes("node_modules"))
  return [...new Set(cleaned)]
}

/**
 * 一个 DESIGN.md 路径引用是否「满足」存在性:
 *  - glob(含 *): 退化为 `*` 前的前缀目录存在(用 split 而非 dirname,后者对 ** 失效).
 *  - 目录(trailing /): statSync isDirectory.
 *  - 文件/无扩展名: existsSync(目录也接受).
 */
function pathIsSatisfied(ref: string): boolean {
  if (ref.includes("*")) {
    const prefix = ref.split("*")[0].replace(/\/?$/, "") // `*` 前的目录前缀
    const dir = join(REPO_ROOT, prefix)
    return existsSync(dir) && statSync(dir).isDirectory()
  }
  if (ref.endsWith("/")) {
    const dir = join(REPO_ROOT, ref.replace(/\/$/, ""))
    return existsSync(dir) && statSync(dir).isDirectory()
  }
  return existsSync(join(REPO_ROOT, ref))
}

describe("design-doc-tree (L1 existence guard)", () => {
  const markdown = readFileSync(DESIGN_MD, "utf8")
  const refs = extractRootedPaths(markdown)

  test("parser sanity: DESIGN.md 至少引用一批 rooted 路径(防空集空跑通过)", () => {
    expect(refs.length).toBeGreaterThan(15)
  })

  test("每个 DESIGN.md 里的 src/ tests/ ui/ 路径引用都在仓库存在(无死条目)", () => {
    const missing = refs.filter((ref) => !pathIsSatisfied(ref))
    expect(missing, `DESIGN.md 引用了不存在的路径(死条目):\n${missing.join("\n")}`).toEqual([])
  })

  test("guard 有效性: planted 死条目能被抓住(防假阴)", () => {
    const planted = extractRootedPaths("see `src/lib/__definitely_not_a_real_file__.ts` for X")
    expect(planted).toContain("src/lib/__definitely_not_a_real_file__.ts")
    expect(planted.some((ref) => !pathIsSatisfied(ref))).toBe(true)
  })
})

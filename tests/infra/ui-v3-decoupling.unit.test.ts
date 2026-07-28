import { ESLint } from "eslint"
import { Glob } from "bun"
import {
  //
  describe,
  expect,
  test,
} from "bun:test"

// 旧 Vue 前端 `ui/` 已于 2026-07-28 从主编译链整体断开（退役 ui-v4 的一步）：
// 不是 workspace 成员、不在根 tsconfig 里、不被 root eslint 扫、后端档位脚本也不聚合它。
// 它只经自己的脚本单独安装 / 编译 / 测试 / 启动（`cd ui && bun install && bun run …`）。
//
// 这些接线每一条都是「一行改动就能悄悄接回去」的形状（往 workspaces 数组里补一个字符串、
// 把 ignore 里的 `ui/**` 删掉），而后果——root 安装重新拖进整套 Vue/Vuetify/Playwright、
// root lint 重新为一个冻结中的子项目报错——要等别人踩到才发现。故结构化钉死。
// 决策与代价见 docs/vue-ui-retirement.md §0。
const REPO_ROOT = new URL("../..", import.meta.url).pathname

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return (await Bun.file(`${REPO_ROOT}/${relativePath}`).json()) as Record<string, unknown>
}

/**
 * `ui/` 下的每一个源文件（相对仓库根），排除安装/构建产物。
 *
 * 下面的 eslint / knip 断言都逐个跑这个集合，而**不是**抽几个代表性路径 ——
 * 抽样挡不住「只忽略了 `ui/src/**`、根层的 `ui/vite.config.ts` 仍在扫」这类
 * 半吊子排除：样本命中了、属性并不成立。集合随目录自动增长，新增子目录无需改守卫。
 */
function uiSourceFiles(): Array<string> {
  const g = new Glob("**/*.{ts,tsx,vue,js,mjs,cjs,json,html}")
  return [...g.scanSync({ cwd: `${REPO_ROOT}ui`, onlyFiles: true })]
    .filter((p) => !p.startsWith("node_modules/") && !p.startsWith("dist/"))
    .map((p) => `ui/${p}`)
    .sort()
}

/** 归一化一条 workspace 模式：bun 认 `ui`/`ui/`/`./ui`/`ui/**`/`./ui/**` 全是同一个声明。 */
function normalizeWorkspacePattern(pattern: string): string {
  return pattern.replace(/^\.\//, "").replace(/\/\*\*$/, "").replace(/\/$/, "")
}

describe("legacy Vue ui/ stays detached from the main chain", () => {
  // 前提校验：下面每条断言都是「ui 不在某处」的否定式，若 ui/ 本身已被整体删除，
  // 它们会全部空转通过。先证被守卫的对象仍然存在，否定断言才有裁决力。
  test("the ui/ workspace still exists (otherwise every assertion below is vacuous)", async () => {
    expect(await Bun.file(`${REPO_ROOT}/ui/package.json`).exists()).toBe(true)
    // 自带 lockfile = 它有独立的安装图，不再靠根 bun.lock hoist。
    expect(await Bun.file(`${REPO_ROOT}/ui/bun.lock`).exists()).toBe(true)
    // 逐文件断言的那几条同样会在集合为空时空转 —— 钉一个下界。
    expect(uiSourceFiles().length).toBeGreaterThan(50)
  })

  test("ui/ is not a root workspace member", async () => {
    const pkg = await readJson("package.json")
    const workspaces = pkg.workspaces as Array<string>
    // 实测（2026-07-28，`bun install --dry-run` 逐一验证）：`ui` / `ui/` / `./ui` /
    // `ui/**` / `./ui/**` / `ui*` 六种写法 bun **全都**认作同一个 workspace 声明。
    // 只断 `not.toContain("ui")` 会被其中四种绕过，故先归一化再判。
    const offenders = workspaces.filter((w) => {
      const normalized = normalizeWorkspacePattern(w)
      return normalized === "ui" || new Glob(normalized).match("ui")
    })
    expect(offenders, `root workspaces declare ui/ (patterns: ${offenders.join(", ")})`).toEqual([])
  })

  test("ui/ is not in the root tsconfig project graph", async () => {
    const tsconfig = await readJson("tsconfig.json")
    const include = tsconfig.include as Array<string>
    const offenders = include.filter((p) => normalizeWorkspacePattern(p).startsWith("ui"))
    expect(offenders, `root tsconfig include pulls in ui/: ${offenders.join(", ")}`).toEqual([])
  })

  test("root eslint ignores every file under ui/", async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT })
    // 用 ESLint 自己的解析结果当 oracle，而不是对配置文件做字符串匹配 —— 后者会被
    // 任何等价改写（换 glob 写法、挪进别的 config 块、改用 files 反向限定）骗过。
    const linted: Array<string> = []
    for (const file of uiSourceFiles()) {
      if (!(await eslint.isPathIgnored(`${REPO_ROOT}${file}`))) linted.push(file)
    }
    expect(linted, `root eslint still lints ${linted.length} file(s) under ui/:\n${linted.slice(0, 10).join("\n")}`).toEqual([])
    // 正样本对照：证明 isPathIgnored 不是对什么都返回 true。
    expect(await eslint.isPathIgnored(`${REPO_ROOT}src/server.ts`)).toBe(false)
    expect(await eslint.isPathIgnored(`${REPO_ROOT}ui-v4/src/main.tsx`)).toBe(false)
  })

  test("root ui scripts invoke ui/ directly, never through the workspace filter", async () => {
    const pkg = await readJson("package.json")
    const scripts = pkg.scripts as Record<string, string>
    // `--filter copilot-api-ui` 在 ui 退出 workspaces 后不再能解析到任何包 —— 留着
    // 就是一个「看起来还在、跑起来必错」的入口。ui-v4 仍是 workspace 成员，不受此限。
    const offenders = Object.entries(scripts)
      .filter(([, body]) => /--filter\s+copilot-api-ui(?!-v4)\b/.test(body))
      .map(([name, body]) => `${name}: ${body}`)
    expect(offenders, `root script(s) still target ui/ through the bun workspace filter:\n${offenders.join("\n")}`).toEqual([])
  })

  test("root knip excludes every file under ui/", async () => {
    // 反直觉之处：移出 workspaces 并**不会**让 knip 忽略该目录 —— 恰恰相反，ui/ 从
    // 「有自己 entry point 的 workspace」降级成「一堆没人引用的散文件」，脱钩当天
    // knip 因此把 97 个 ui/ 文件报成 unused。故须显式 ignore。
    const knip = await readJson("knip.json")
    const ignore = knip.ignore as Array<string>
    // 逐文件判定而非抽样：`ignore: ["ui/src/**"]` 能让抽样版假绿，却漏掉根层的
    // vite/vitest/playwright 配置和 tests/ vitest/ 两棵测试树。
    const covered = (file: string): boolean => ignore.some((p) => new Glob(p).match(file))
    const uncovered = uiSourceFiles().filter((f) => !covered(f))
    expect(uncovered, `knip.json ignore misses ${uncovered.length} file(s) under ui/:\n${uncovered.slice(0, 10).join("\n")}`).toEqual([])
    // 正样本对照：这些模式不该顺手把后端或 ui-v4 也一起忽略掉。
    for (const kept of ["src/server.ts", "ui-v4/src/main.tsx", "tests/infra/ui-v3-decoupling.unit.test.ts"]) {
      expect(covered(kept), `knip.json ignore unexpectedly covers ${kept}`).toBe(false)
    }
  })
})

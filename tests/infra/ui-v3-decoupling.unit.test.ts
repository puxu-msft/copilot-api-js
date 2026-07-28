import { ESLint } from "eslint"
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

describe("legacy Vue ui/ stays detached from the main chain", () => {
  // 前提校验：下面每条断言都是「ui 不在某处」的否定式，若 ui/ 本身已被整体删除，
  // 它们会全部空转通过。先证被守卫的对象仍然存在，否定断言才有裁决力。
  test("the ui/ workspace still exists (otherwise every assertion below is vacuous)", async () => {
    expect(await Bun.file(`${REPO_ROOT}/ui/package.json`).exists()).toBe(true)
    // 自带 lockfile = 它有独立的安装图，不再靠根 bun.lock hoist。
    expect(await Bun.file(`${REPO_ROOT}/ui/bun.lock`).exists()).toBe(true)
  })

  test("ui/ is not a root workspace member", async () => {
    const pkg = await readJson("package.json")
    const workspaces = pkg.workspaces as Array<string>
    expect(workspaces).not.toContain("ui")
    // `packages/*` 一类的 glob 不会命中 ui/，但 `ui*` / `*` 会 —— 一并挡掉。
    const globHits = workspaces.filter((w) => w !== "ui-v4" && new Bun.Glob(w).match("ui"))
    expect(globHits, `root workspaces pattern(s) match ui/: ${globHits.join(", ")}`).toEqual([])
  })

  test("ui/ is not in the root tsconfig project graph", async () => {
    const tsconfig = await readJson("tsconfig.json")
    const include = tsconfig.include as Array<string>
    const offenders = include.filter((p) => p === "ui" || p.startsWith("ui/"))
    expect(offenders, `root tsconfig include pulls in ui/: ${offenders.join(", ")}`).toEqual([])
  })

  test("root eslint ignores ui/ entirely", async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT })
    // 用 ESLint 自己的解析结果当 oracle，而不是对配置文件做字符串匹配 —— 后者会被
    // 任何等价改写（换 glob 写法、挪进别的 config 块）骗过。
    for (const file of ["ui/src/main.ts", "ui/src/components/message/ToolUseBlock.vue", "ui/tests/entry-legs.test.ts", "ui/vitest/detail-page.test.ts"]) {
      expect(await eslint.isPathIgnored(`${REPO_ROOT}${file}`), `${file} is NOT ignored by the root eslint config`).toBe(true)
    }
    // 正样本对照：证明 isPathIgnored 不是对什么都返回 true。
    expect(await eslint.isPathIgnored(`${REPO_ROOT}src/server.ts`)).toBe(false)
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
})

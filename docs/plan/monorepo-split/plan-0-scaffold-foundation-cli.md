# Phase 0：脚手架 + 边界 lint + foundation + cli 包 — 实施计划

> **实施状态（2026-07-23，全 5 task landed + 已合并 master `390bae31`）**：✅ 完成并合并。Task1 PoC gate `c7f39c54`、Task2 scaffold `8cf733bd`、Task3 boundary lint `3e1a1373`、Task4 foundation move `a37d93cc`、Task5 cli extract `151f974a`；分支合最新 master 后 test:backend **6305 pass / 0 fail**、typecheck GREEN、边界守卫 11 pass、build 单产物、bin 不变；经 `--ff-only` 干净合入 master（与并发 peer 的 codec-resolveCodecModel 多提交重构冲突：等其落定后合才自洽——教训见下）。**下一步 Phase 0d**（state 窄接口 seam）。

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。步骤用 `- [ ]` 跟踪。索引与全局约束见 [README.md](README.md)。spec = [../../spec/2026-07-22-monorepo-workspace-split.md](../../spec/2026-07-22-monorepo-workspace-split.md)。

**Goal:** 把 workspace 骨架、边界 lint 硬强制、`@hsupu/ghc-proxy-foundation`（真叶子纯基元）、`@hsupu/ghc-proxy-cli`（8 顶层文件）立起来，运行时行为逐字节不变。

**Architecture:** 冷区先切、零烫区文件位移。过渡期用根 tsconfig `~/*` 子路径映射让搬迁后的文件仍被旧 `~/lib/x` import 解析（避免一次性大改 import）。边界用 ESLint `no-restricted-imports`（复用项目既有 TUI/sink 边界规则的同一手法）。

**Tech Stack:** Bun workspaces（单 `bun.lock` hoist）、tsdown（rolldown）、ESLint（`@echristian/eslint-config`）、`bun test`。

## Global Constraints（详见 README）

- 包名 `@hsupu/ghc-proxy-{foundation,cli}`；根包/bin 不改。
- 每 commit：typecheck + `bun run test:backend` 绿 + `bun run lint:all` 无新增违规 + `GET /openapi.json` 字节不变 + 显式 pathspec 提交。
- 冻结 oracle = pre-move HEAD 已通过的 test:backend + openapi 快照；**不新增 golden**。

---

## 就绪度门槛（Phase 0 前必读）

Phase 0 依赖两个未验证机制，**Task 1 是 PoC gate，不过不得进 Task 2**：
1. 根 tsconfig `paths` 加 `~/lib/<x>/*` → `packages/foundation/src/<x>/*` 子路径映射后，**bun test / tsc / tsdown 三者都能解析**（bun 运行时对 tsconfig paths 的支持是关键未知）。
2. tsdown 从 `src/main.ts` 入口沿 workspace 包 import bundle 时对 `workspace:*` 依赖是内联（期望）还是外联。

> **✅ PoC 结论（2026-07-23，Task 1 已执行，gate PASS）**：两者均验证可行。(a) `~/lib/<x>/*` 精确映射（排在 `~/*` 通配前）被 **bun run / bun test / tsc(skipLibCheck) 三者解析**，负对照（去映射→tsc 报 `Cannot find module`）证明是映射本身生效——**搬迁叶子后旧 `~/lib/x` import 零改仍解析**；(b) tsdown **内联** 别名依赖进单产物——Phase 3 build 保持单入口、不给每包出 dist。详见 worktree 内 `exp/monorepo-split/tsdown-poc/FINDINGS.md`（gitignore、本地）。

---

## File Structure

- `package.json`（根）— `workspaces` 追加 `packages/*`。
- `packages/foundation/package.json` `packages/foundation/tsconfig.json` — 新建，foundation 包定义。
- `packages/foundation/src/**` — 迁入的纯基元（`util/`、`diff/`、`stream.ts`、`atomic-fs.ts`、`process-identity.ts`、`repetition-detector.ts`）。
- `packages/cli/package.json` — 新建，cli 包定义（过渡期 src 仍经 `~/*` 引 core）。
- `packages/cli/src/**` — 8 个顶层文件（`main`/`auth`/`debug`/`logout`/`list-claude-code`/`setup-claude-code`/`setup-codex`/`start`）。
- `tsconfig.json`（根）— `paths` 追加 foundation 子路径映射。
- `eslint.config.js` — 追加层序边界规则块。
- `tests/architecture/package-boundaries.unit.test.ts` — 新建，边界守卫（正样本先证能抓）。
- `tsdown.config.ts` — 入口从 `src/main.ts` 改 `packages/cli/src/main.ts`（Task 5）。

---

## Task 1：PoC gate — 过渡别名子路径映射 + tsdown workspace 依赖

**Files:**
- Create: `exp/monorepo-split/tsdown-poc/`（实验代码 + `FINDINGS.md`）

**Interfaces:**
- Produces: `FINDINGS.md` 记两个结论——(a) `~/lib/<x>/*` 子路径映射是否被 bun test + tsc + tsdown 三者解析；(b) tsdown 对 `workspace:*` 内联/外联。后续 Task 依赖 (a) 成立。

- [ ] **Step 1：造最小复现——一个被移动的叶子文件 + 别名映射**

在 `exp/monorepo-split/tsdown-poc/` 建最小 workspace：一个 `pkg-foundation/src/util/demo.ts`（导出 `export const demo = () => 42`）、一个消费者 `app/src/main.ts`（`import { demo } from "~/lib/util/demo"`），根 tsconfig `paths: { "~/lib/util/*": ["./pkg-foundation/src/util/*"] }`。

- [ ] **Step 2：验证 bun 能解析子路径别名到别处的物理位置**

Run: `cd exp/monorepo-split/tsdown-poc && bun run app/src/main.ts`
Expected: 打印 `42`（证明 bun 运行时解析 `~/lib/util/*` 到 foundation 物理位置）。若失败 → 别名子路径映射方案不成立，**停下改用 re-export shim 方案**（在 `FINDINGS.md` 记录并上报 orchestrator）。

- [ ] **Step 3：验证 bun test 同样解析该别名**

写 `app/tests/demo.unit.test.ts`（`import { demo } from "~/lib/util/demo"; expect(demo()).toBe(42)`），Run: `bun test app/tests/demo.unit.test.ts`
Expected: PASS。

- [ ] **Step 4：验证 tsdown bundle 该消费者、workspace 依赖内联**

配 tsdown entry=`app/src/main.ts`，Run: `bunx tsdown` 后检查 `dist` 单产物是否内联了 `demo`。
Expected: 记录内联 vs 外联结论到 `FINDINGS.md`（影响 Phase 3 build 脚本，非 Phase 0 blocker）。

- [ ] **Step 5：Commit（exp/ 是 gitignore，若被忽略则只提交 FINDINGS 摘要到 plan 备注）**

```bash
git add -- exp/monorepo-split/tsdown-poc/FINDINGS.md 2>/dev/null || echo "exp gitignored; paste FINDINGS summary into plan-0 as a note"
```

> **Gate**：Step 2/3 任一失败 → 不进 Task 2，改 re-export shim 方案（老路径留 `export * from "@hsupu/ghc-proxy-foundation/util/demo"` 薄 shim），并回 spec §8.1 修订别名策略。

---

## Task 2：Workspace 骨架 + foundation 空包

**Files:**
- Modify: `package.json`（根）`workspaces`
- Create: `packages/foundation/package.json`、`packages/foundation/tsconfig.json`、`packages/foundation/src/index.ts`（空 barrel）

**Interfaces:**
- Produces: `@hsupu/ghc-proxy-foundation` 包存在、可被 workspace resolve（暂空）。

- [ ] **Step 1：写失败断言——foundation 包应可被 bun 识别为 workspace 成员**

写 `tests/architecture/package-boundaries.unit.test.ts`（首个 case）：
```ts
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

describe("workspace packages", () => {
  test("root workspaces includes packages/*", async () => {
    const pkg = JSON.parse(await readFile(path.resolve(import.meta.dir, "../../package.json"), "utf8"))
    expect(pkg.workspaces).toContain("packages/*")
  })
  test("foundation package.json declares correct name", async () => {
    const pkg = JSON.parse(await readFile(path.resolve(import.meta.dir, "../../packages/foundation/package.json"), "utf8"))
    expect(pkg.name).toBe("@hsupu/ghc-proxy-foundation")
    expect(pkg.private).toBe(true)
  })
})
```

- [ ] **Step 2：跑，确认失败**

Run: `bun test tests/architecture/package-boundaries.unit.test.ts`
Expected: FAIL（`packages/*` 不在 workspaces / foundation package.json 不存在）。

- [ ] **Step 3：建 foundation 包定义 + 追加 workspaces**

`packages/foundation/package.json`：
```json
{
  "name": "@hsupu/ghc-proxy-foundation",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./*": "./src/*" }
}
```
`packages/foundation/tsconfig.json`：
```json
{ "extends": "../../tsconfig.json", "include": ["src/**/*.ts"] }
```
`packages/foundation/src/index.ts`：`export {}`（暂空）。
根 `package.json` `workspaces`：`["ui", "ui-v4", "packages/*"]`。

- [ ] **Step 4：跑测试 + install 让 workspace 生效**

Run: `bun install && bun test tests/architecture/package-boundaries.unit.test.ts`
Expected: PASS。

- [ ] **Step 5：验证全局 invariant 未破**

Run: `bun run typecheck && bun run test:backend`
Expected: 全绿（纯新增、零行为变化）。

- [ ] **Step 6：Commit**

```bash
git add -- package.json bun.lock packages/foundation/ tests/architecture/package-boundaries.unit.test.ts
git commit -m "chore(monorepo): scaffold workspaces + empty foundation package"
```

---

## Task 3：边界 lint 规则 + 架构守卫测试（正样本先证能抓）

**Files:**
- Modify: `eslint.config.js`（追加层序块）
- Modify: `tests/architecture/package-boundaries.unit.test.ts`（追加 foundation↛上层 守卫）

**Interfaces:**
- Consumes: foundation 包存在（Task 2）。
- Produces: lint 规则「foundation 不许 import core/server/cli / `~/lib/{非foundation域}`」；架构测试断言 foundation 源码零上层 import。

- [ ] **Step 1：写正样本——先证守卫能抓到违规（catch-false-green）**

在 `package-boundaries.unit.test.ts` 追加：临时把一条违规字符串喂给检测函数，断言它被标记：
```ts
test("boundary detector flags an upward import (positive control)", async () => {
  const violates = (src: string) =>
    /from ["'](?:@hsupu\/ghc-proxy-(?:core|server|cli)|~\/lib\/(?!util|diff|stream|atomic-fs|process-identity|repetition-detector))/.test(src)
  expect(violates('import { x } from "~/lib/state"')).toBe(true)       // 正样本必被抓
  expect(violates('import { x } from "~/lib/util/abortable-delay"')).toBe(false) // foundation 内部允许
})
```

- [ ] **Step 2：写真守卫——foundation 源码零上层 import**

```ts
test("foundation package imports nothing above it", async () => {
  const root = path.resolve(import.meta.dir, "../../packages/foundation/src")
  const files = await sourceFiles(root)  // 复用 generation-engine-boundaries 的 sourceFiles helper（抄进本文件或提取共享）
  const violates = (src: string) =>
    /from ["'](?:@hsupu\/ghc-proxy-(?:core|server|cli)|~\/lib\/(?!util|diff|stream|atomic-fs|process-identity|repetition-detector))/.test(src)
  for (const f of files) expect(violates(await readFile(f, "utf8")), f).toBe(false)
})
```

- [ ] **Step 3：跑——此刻 foundation src 为空/仅 index，守卫应 PASS（但正样本证明它有效）**

Run: `bun test tests/architecture/package-boundaries.unit.test.ts`
Expected: PASS（正样本 + 空 foundation 都过）。

- [ ] **Step 4：追加 ESLint 层序块**

`eslint.config.js` 在既有 `no-restricted-imports` 块群后追加（模仿 `:166` `src/lib/request/**` 块结构）：
```js
{
  files: ["packages/foundation/src/**/*.ts"],
  rules: {
    "no-restricted-imports": ["error", { patterns: [
      { group: ["@hsupu/ghc-proxy-core", "@hsupu/ghc-proxy-server", "@hsupu/ghc-proxy-cli", "~/lib/*"], message: "foundation 是叶子，禁 import 上层包（见 spec §4）" },
    ]}],
  },
},
```

- [ ] **Step 5：验证 lint 绿 + 正样本**

Run: `bunx eslint packages/foundation/src/`（此刻空/仅 index → 0 违规）
再临时在 `packages/foundation/src/index.ts` 加一行 `import "~/lib/state"`，Run: `bunx eslint packages/foundation/src/` → Expected: 报 `no-restricted-imports` 错（证规则生效）。**删掉该临时行**。

- [ ] **Step 6：Commit**

```bash
git add -- eslint.config.js tests/architecture/package-boundaries.unit.test.ts
git commit -m "feat(monorepo): boundary lint + architecture guard for foundation leaf"
```

---

## Task 4：迁移真叶子纯基元进 foundation + 别名子路径映射

**Files:**
- Move: `src/lib/util/*` `src/lib/diff/*` `src/lib/stream.ts` `src/lib/atomic-fs.ts` `src/lib/process-identity.ts` `src/lib/repetition-detector.ts` → `packages/foundation/src/`
- Modify: `tsconfig.json`（根）`paths` 追加子路径映射
- Modify: `packages/foundation/src/index.ts`（re-export 迁入模块）

**Interfaces:**
- Consumes: Task 1 PoC 确认别名映射可行。
- Produces: 纯基元物理在 foundation，旧 `~/lib/{util,diff,stream,...}` import **不改仍解析**。

> **为何这批**：spec §2.1/§3.1 + 实测证零 core 依赖（`util/abortable-delay` 3 consumer、`stream.ts` 0 import）。**不含 sqlite/driver**（10+ consumer、跨 history/telemetry，风险高，留独立 task 或 Phase 0 收尾单独处理）；**不含 error 纯基元**（需先解 `ToolDiagnostics` 类型链，spec §3.2，留 Phase 0d/独立）。

- [ ] **Step 1：先跑基线，锁 pre-move 绿**

Run: `bun run test:backend` → 记录 pass 数（冻结 oracle 基线）。

- [ ] **Step 2：git mv 迁移（保留历史）+ 补别名映射**

```bash
mkdir -p packages/foundation/src/util packages/foundation/src/diff
git mv src/lib/util/abortable-delay.ts packages/foundation/src/util/abortable-delay.ts
git mv src/lib/diff/block-align.ts packages/foundation/src/diff/block-align.ts
git mv src/lib/stream.ts packages/foundation/src/stream.ts
git mv src/lib/atomic-fs.ts packages/foundation/src/atomic-fs.ts
git mv src/lib/process-identity.ts packages/foundation/src/process-identity.ts
git mv src/lib/repetition-detector.ts packages/foundation/src/repetition-detector.ts
```
根 `tsconfig.json` `paths` 追加（**顺序在 `~/*` 通配前**，具体优先）：
```json
"~/lib/util/*": ["./packages/foundation/src/util/*"],
"~/lib/diff/*": ["./packages/foundation/src/diff/*"],
"~/lib/stream": ["./packages/foundation/src/stream"],
"~/lib/atomic-fs": ["./packages/foundation/src/atomic-fs"],
"~/lib/process-identity": ["./packages/foundation/src/process-identity"],
"~/lib/repetition-detector": ["./packages/foundation/src/repetition-detector"],
"~/*": ["./src/*"]
```

- [ ] **Step 3：typecheck 验证别名解析（旧 import 未改仍找得到）**

Run: `bun run typecheck`
Expected: PASS（若报「cannot find module ~/lib/stream」→ 别名映射顺序/写法错，修 paths；bun tsconfig paths 对精确 key 优先于通配）。

- [ ] **Step 4：test:backend 验证运行时解析 + 行为不变**

Run: `bun run test:backend`
Expected: pass 数 = Step 1 基线（零回归）。若某测试 `cannot find module` → bun 运行时未解析该别名，回 Task 1 PoC 结论换 shim 方案。

- [ ] **Step 5：foundation 内部 import 收敛为相对 + 更新 index barrel**

迁入文件里若有 `~/lib/{同批}` 互引，改相对 `./`（如 stream 引 util → `./util/abortable-delay`）。`packages/foundation/src/index.ts` re-export：`export * from "./stream"` 等。Run: `bun run typecheck && bunx eslint packages/foundation/src/`
Expected: 绿（含 Task 3 边界守卫、架构测试 foundation↛上层仍 PASS）。

- [ ] **Step 6：Commit**

```bash
git add -- src/lib packages/foundation tsconfig.json
git commit -m "refactor(monorepo): move leaf primitives to foundation via transitional alias"
```

---

## Task 5：cli 包（8 顶层文件，过渡期经 `~/*` 引 core）

**Files:**
- Create: `packages/cli/package.json`
- Move: `src/main.ts` `src/auth.ts` `src/debug.ts` `src/logout.ts` `src/list-claude-code.ts` `src/setup-claude-code.ts` `src/setup-codex.ts` `src/start.ts` → `packages/cli/src/`
- Modify: `tsconfig.json` paths、`tsdown.config.ts` entry、根 `package.json` bin
- Modify: `packages/cli/src/*` 的相对 import（`./lib/x`→`~/lib/x`、`./routes`→经包名/别名）

**Interfaces:**
- Consumes: foundation 已在包内（Task 4）；core/server 尚未成包（仍 `src/lib`、`src/routes`）。
- Produces: bin 入口在 `packages/cli/src/main.ts`；`server.ts` **留 `src/`**（归未来 server 包，不迁 cli）。

> **关键**：core/server 未成包，cli 对它们的依赖过渡期走 `~/lib/*` / `~/routes/*` 别名（解析回 `src/`）。`server.ts` 不迁（spec §3.1，它 import routes、归 server 包）；`start.ts` 迁 cli，其 `./routes`/`./lib/serve` 改 `~/routes`/`~/lib/serve`。

- [ ] **Step 1：基线**

Run: `bun run test:backend && bun run start --help`（记录 help 输出作 bin 行为 oracle）。

- [ ] **Step 2：建 cli 包定义 + git mv 8 文件**

`packages/cli/package.json`：
```json
{ "name": "@hsupu/ghc-proxy-cli", "version": "0.0.0", "private": true, "type": "module", "exports": { ".": "./src/main.ts" } }
```
```bash
mkdir -p packages/cli/src
for f in main auth debug logout list-claude-code setup-claude-code setup-codex start; do git mv src/$f.ts packages/cli/src/$f.ts; done
# server.ts 不迁——留 src/
```

- [ ] **Step 3：改迁入文件的相对 import 为别名**

`packages/cli/src/*` 内所有 `from "./lib/x"` → `from "~/lib/x"`；`start.ts` 的 `from "./routes"` → `from "~/routes"`、`from "./routes/ui/route"` → `from "~/routes/ui/route"`；`main.ts` 的 `from "./start"` → `from "./start"`（同包相对，保留）；对 `server.ts` 的引用（若有，经 `~/server`）。用 `ts-morph` 或逐文件 Edit（**不用 sed**，记忆库 `sed-touched-files-bundle-inflight-work`）。

- [ ] **Step 4：改 tsdown entry + bin + typecheck**

`tsdown.config.ts`：`entry: ["packages/cli/src/main.ts"]`。根 `package.json` `bin`: `{ "copilot-api": "dist/main.mjs" }`（产物路径不变）。根 tsconfig `include` 追加 `packages/**/*.ts`。
Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 5：build + 运行时 oracle 不变**

Run: `bun run build:backend && bun run test:backend`
Expected: `dist/main.mjs` 产出、test:backend = 基线。
Run: `bun run start --help`（或 `node dist/main.mjs --help`）→ Expected: 输出 = Step 1 oracle 逐行不变。

- [ ] **Step 6：lint 边界 + 架构守卫（cli 允许 import core/server）**

追加 `eslint.config.js` cli 块：`files: ["packages/cli/src/**/*.ts"]`，禁 import `@hsupu/ghc-proxy-foundation` 深路径外无约束（cli 是顶点、合法依赖 core/server）；架构测试追加「core（`src/lib`）不 import cli」。
Run: `bunx eslint packages/cli/src/ && bun test tests/architecture/package-boundaries.unit.test.ts`
Expected: 绿。

- [ ] **Step 7：Commit**

```bash
git add -- src packages/cli tsconfig.json tsdown.config.ts package.json eslint.config.js tests/architecture/package-boundaries.unit.test.ts
git commit -m "refactor(monorepo): extract cli package (8 top files, transitional alias to core)"
```

---

## Self-Review（写完对照 spec）

- **spec §7.2 阶段 0a/0b/0c 覆盖**：0a=Task 2、0c=Task 4、0b=Task 5 ✅（0d 独立 plan）。
- **spec §4 lint 硬强制**：Task 3 ✅。**spec §7.3 invariant**：每 task Step 含 typecheck+test:backend+lint+openapi/help oracle ✅。
- **spec §9 陷阱**：PoC gate（Task 1）覆盖别名/tsdown 未知；`server.ts` 归属（Task 5 Step 2 显式不迁）覆盖 blocker；codemod-not-sed（Task 5 Step 3）✅。
- **缺口**：sqlite/driver + error 纯基元未在 Phase 0 迁（风险高、需先解链）——已在 Task 4 备注标记为独立后续，非 silently cut。

---

## Kick-off Prompt（复制启动 Phase 0）

```
执行 docs/plan/monorepo-split/plan-0-scaffold-foundation-cli.md 的 Phase 0。
先读 README.md 全局约束 + spec §4/§7/§8/§9。严格按 Task 1→5 顺序：
- Task 1 是 PoC gate，Step 2/3 失败则停下换 re-export shim 方案、上报，不进 Task 2。
- 每 task 每 commit 必过：typecheck + test:backend（全后端、非 fast）+ lint:all + openapi/help oracle 不变 + 显式 pathspec 提交。
- 物理搬迁前 git worktree list + git log -5 -- <目标路径> 现场重核无活跃占用。
- 用 git mv 保历史、ts-morph/逐文件 Edit 改 import（禁 sed）。
- server.ts 不迁 cli（归未来 server 包）。
判据：长远正确+完整 > 省事，禁 ROI/YAGNI 砍范围。
```

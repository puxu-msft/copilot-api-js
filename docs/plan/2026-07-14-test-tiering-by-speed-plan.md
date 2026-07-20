# 测试按速度分档 Implementation Plan

> **实施状态（2026-07-20，分支 `test-tiering-by-speed`）**：✅ 全部 landed（Task 1a→6）。执行期实证调整：
> - **Task 0a/0b（P0 4 失败）跳过**——master 前进后 peer 已修好（console-thinking/resetters 全绿，实证）；执行期真实基线的失败换成了另一批（见下）。
> - **孤儿实数 56**（tests 46 + src 10，master 变动致数字与计划的 55/60 有出入，L1 守卫动态无碍）。
> - **Task 2b 降验证性**——e2e 早已 token-gated（`c1589b00`），干净环境 59 skip/0 fail，非新增。
> - **Task 4**：`request-payload` 26s→2.2s（根因=`"x".repeat` 触发 gpt-tokenizer 病态级联，换真实词句，**保 .unit 真相域**）；`system-prompt-config-integration` 真 fs I/O 误配→`.it`；其余 telemetry SQLite 单元测试守约定不重分类、记 backlog。
> - **Task 5 doc-sync**：约定立在活文档（CLAUDE.md/coding-conventions/DESIGN），历史 plan/rfc/kickoff 叙事按反修正主义不逐个改写。
> - **实测（本机、master 已增长至 unit 350+it 114+http 64 文件）**：默认 `test`(fast) 170s vs `test:backend`(全后端) 409s（**默认反馈 -58%**）。绝对值远高于计划期 ~38s——因 master 期间 unit 档从 265→350 文件膨胀（含大量真 SQLite 测试），非分档本身；进一步压缩（持久化单元测试走 in-memory SQLite）已记 backlog。
> - **遗留失败均 pre-existing/flaky**（h2-keepalive 争用 flaky、V3 perf load 敏感、SIGINT 机器负载、V3 semantic peer 活跃区）——base 对照由 verifier 核验中，非本次引入（未改任何 src 逻辑）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把后端测试按速度分档——默认 `test` 只跑快速档（unit+http，~38s），集成/pty/e2e 按需运行；同时修 4 个预存真失败、收编 55 个孤儿测试、统一 e2e 发现机制、立一道 L1 守卫永久防孤儿复发。

**Architecture:** 两条轴——类型轴（后缀 `.unit/.it/.http/.pty/.e2e` = 真相域，不变）与执行轴（tier = 类型→档位映射，靠 package.json 脚本按后缀组合表达，不新增速度轴、不按速度改名）。所有改动落在 package.json 脚本、测试文件重命名/迁移、一个新守卫测试、一处 RESETTERS 注册、一个夹具修复、文档同步。

**Tech Stack:** bun test（`bunfig.toml` `[test] root=./tests`，位置参数按文件名子串 OR 过滤）、TypeScript、`~/*`→`src/*` alias（tsconfig）。

Spec：[docs/spec/2026-07-14-test-tiering-by-speed.md](../spec/2026-07-14-test-tiering-by-speed.md)（权威，含 review 台账 §13）。

## Global Constraints

- **守后缀=类型（硬规则）**：改名 `.unit → .it` 的**唯一充分条件**是独立实测确认真相域确为集成（做真 I/O/spawn/起服务）。慢**只是**触发复核的信号，绝不作改名理由。慢的纯单元留 unit + 注释。
- **绝不引入速度标记**（`.slow.` 中缀/目录）。tier 只靠脚本按后缀组合。
- **绝不为过守卫而删/放宽断言**（P0a）：接线缺失补供给（supply），遵 `broken-reference-supply-vs-delete`。
- **绝不杀 4141 端口主服务器**；起测试用其他端口、按 PID 精确清理。
- **细粒度提交**：一律显式 pathspec（`git add -- <精确路径>`、`git commit -- <精确路径>`），每语义单元一提交，conventional commits，无模型署名。
- **不改 `bunfig.toml` `root` 配置**（避免双发现源）；src 测试靠迁移到 `tests/` 解决发现。
- 后缀集权威 = `{unit, it, http, pty, e2e}`。

---

## Task 0a: 补注册 resetReaperDiagnosticsForTests 进 RESETTERS（修 P0a 隔离接线缺失）

**根因**（已核实）：`src/lib/observability/reaper-diagnostics.ts:123` 导出 `resetReaperDiagnosticsForTests`（清 module-global `ring`/`lastReloadDiff`/`elHist` 真状态），但 `tests/helpers/isolated-fixture.ts` 的 RESETTERS 表未注册它。L1 守卫 `tests/infra/resetters-complete.unit.test.ts` 枚举全 `src/` 的 `*ForTest(s|ing)` 导出、要求各自 register 或 EXEMPT，正确报错。（注：其余 6 个 backfill 模块的姊妹 reset 注释都写了「registered in RESETTERS」约定，`reaper-diagnostics.ts` 本身漏写该注释、也漏注册——补注册即可，无需补注释。）

**Files:**
- Modify: `tests/helpers/isolated-fixture.ts`（import 段 + RESETTERS 数组）
- Test（既有守卫，无需新建）：`tests/infra/resetters-complete.unit.test.ts`

**Interfaces:**
- Consumes: `resetReaperDiagnosticsForTests` from `~/lib/observability/reaper-diagnostics`
- Produces: RESETTERS 表新增一项（afterEach 会调用它重置 reaper 诊断 singleton）

- [ ] **Step 1: 先证守卫当前红（正样本对照）**

Run: `bun test tests/infra/resetters-complete.unit.test.ts`
Expected: FAIL，失败项为 `resetReaperDiagnosticsForTests`（`every src *ForTest(s|ing) export is registered or exempted`）。

- [ ] **Step 2: 加 import**

在 `tests/helpers/isolated-fixture.ts` 的 import 段（与其它 observability import 相邻，如 `resetProcessIdentityForTests` 之后）加：

```ts
import { resetReaperDiagnosticsForTests } from "~/lib/observability/reaper-diagnostics"
```

- [ ] **Step 3: 注册进 RESETTERS 数组**

在 `RESETTERS` 数组内（与其它 observability reset 相邻，如 `resetTerminalCoordinatorForTests` 附近）加一行：

```ts
  { name: "resetReaperDiagnosticsForTests", reset: resetReaperDiagnosticsForTests },
```

- [ ] **Step 4: 证守卫转绿**

Run: `bun test tests/infra/resetters-complete.unit.test.ts`
Expected: PASS（3 pass, 0 fail）。

- [ ] **Step 5: Commit**

```bash
git add -- tests/helpers/isolated-fixture.ts
git commit -m "fix(test): register resetReaperDiagnosticsForTests in RESETTERS"
```

---

## Task 0b: 修 console-thinking 夹具的不真实状态序列（修 P0b）

**根因**（已核实）：`tests/observability/console-thinking.unit.test.ts` 的 `makeCtx()` 硬编码 `state:"completed"`，并把该 terminal ctx 同时用于 `request.feature_applied` 与 `request.completed` event。而 `src/lib/tui/terminal-ui.ts` 对 terminal state 的 ctx 刻意返回不入 active map 的 throwaway entry（防 terminal request 被重新 materialize），故 feature 写不进 active entry → 3 个断言失败。真实生命周期里 feature event 发生在**非 terminal**状态。

**裁决方向**：夹具陈旧——feature event 应携**非 terminal** ctx（如 `state:"streaming"`），completed event 才携 terminal ctx。修夹具使其重现真实序列；若修后生产 console 契约仍不满足则属真回归，另立 finding。**先修夹具、跑、按结果裁决**，不预设删断言。

**Files:**
- Modify: `tests/observability/console-thinking.unit.test.ts`
- Read（判生产契约）：`src/lib/tui/terminal-ui.ts:415-426,552-567`

- [ ] **Step 1: 复现并读实现确认契约**

Run: `bun test tests/observability/console-thinking.unit.test.ts`
Expected: FAIL（3 fail / 3 pass）。
读 `src/lib/tui/terminal-ui.ts` 的 `upsertCtx`（~552-567）确认 terminal ctx 返回 throwaway entry、非 terminal ctx 写 active map。

- [ ] **Step 2: 改夹具——feature event 用非 terminal ctx**

把 `makeCtx()` 拆成两态构造器（保留 completed 用的 terminal ctx，新增 feature 用的 active ctx）：

```ts
function makeActiveCtx(id = "ctx-1"): RequestContextSnapshot {
  return { id, endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", state: "streaming", startTime: Date.now() - 100, queueWaitMs: 0 }
}
function makeCompletedCtx(id = "ctx-1"): RequestContextSnapshot {
  return { id, endpoint: "anthropic-messages", method: "POST", path: "/v1/messages", state: "completed", startTime: Date.now() - 100, queueWaitMs: 0 }
}
```

把三个失败用例里传给 `thinkingEvent(...)` 的 ctx 改为 `makeActiveCtx()`（同 id），completed event 仍用 `makeCompletedCtx()`（同 id，关联同一 request）。保持 event 顺序：先若干 feature（active ctx）→ 末尾 completed（terminal ctx）。

- [ ] **Step 3: 跑并按结果裁决**

Run: `bun test tests/observability/console-thinking.unit.test.ts`
Expected: PASS（6 pass）。
若仍红：说明生产 console 契约在真实序列下也不满足 → **停，记 finding 入 `docs/todo/deferred-backlog.md`（带根因：文件:行 + 观测），不删断言**，交用户裁决是否属生产回归。

- [ ] **Step 4: 全 unit 档回归（确认无其它连带）**

Run: `bun run test:unit`（改脚本前仍是 unit）
Expected: 0 fail（原 4 fail 应全清）。

- [ ] **Step 5: Commit**

```bash
git add -- tests/observability/console-thinking.unit.test.ts
git commit -m "fix(test): use realistic non-terminal ctx for thinking feature events"
```

---

## Task 1a: 新增 L1 测试发现矩阵守卫（永久防孤儿/分裂）

**目的**：枚举全仓 `**/*.test.ts`，断言每个文件后缀 ∈ 权威集且不在 `src/`，从结构上杜绝「已分档但无脚本运行」的盲区。这是 P3 收编的验收 oracle，也是长远防线。

**Files:**
- Create: `tests/infra/test-discovery-matrix.unit.test.ts`

**Interfaces:**
- Consumes: 无（用 `Bun.Glob` 扫盘）
- Produces: 一个 L1 守卫，任何未来新增孤儿/双命名/src 漏迁即红

- [ ] **Step 1: 写守卫测试**

```ts
import { describe, expect, test } from "bun:test"
import { Glob } from "bun"

// 权威后缀集：每个后端测试文件必须恰好带其一，且必须位于 tests/（bunfig root=./tests）
const VALID_SUFFIXES = [".unit.test.ts", ".it.test.ts", ".http.test.ts", ".pty.test.ts", ".e2e.test.ts"]
const REPO_ROOT = new URL("../..", import.meta.url).pathname

function scan(dir: string): string[] {
  const g = new Glob("**/*.test.ts")
  return [...g.scanSync({ cwd: `${REPO_ROOT}/${dir}`, onlyFiles: true })].map((p) => `${dir}/${p}`)
}

describe("test discovery matrix", () => {
  test("every tests/ file carries exactly one authoritative suffix", () => {
    const offenders = scan("tests").filter((f) => !VALID_SUFFIXES.some((s) => f.endsWith(s)))
    expect(offenders, `orphan/misnamed test files (no tier suffix):\n${offenders.join("\n")}`).toEqual([])
  })

  test("no test files live under src/ (root=./tests would hide them)", () => {
    const srcTests = scan("src")
    expect(srcTests, `src/ test files are undiscoverable under root=./tests:\n${srcTests.join("\n")}`).toEqual([])
  })
})
```

- [ ] **Step 2: 跑——预期现在红（还没收编，正样本对照证守卫有效）**

Run: `bun test tests/infra/test-discovery-matrix.unit.test.ts`
Expected: FAIL，两个 test 都列出当前 offenders（tests/ ~42 个无后缀 + src/ 13 个）。这证明守卫能抓到问题（先红后绿）。

- [ ] **Step 3: 该守卫提交为红 tripwire——中间态不做 fast 全绿验收**

守卫此刻应红（列出当前 ~46 个 tests/ 无后缀 + 13 个 src/ 孤儿），这是 P3 的验收目标。提交为红色 tripwire；P3 逐批收编，每批收编后重跑本守卫，最后一批完成后守卫转绿。**在 Task 1a 提交之后、Task 3 全部完成之前**，`bun run test:fast`/`test:unit` 的文件数会包含此红守卫（unit 档从 326→327）且**不作为验收依据**——这一区间内不做 fast 全绿检查，避免被红 tripwire 干扰。Task 2 Step 2 的「fast 发现集=326」验收若排在 Task 1a 之后，会看到 327，属预期（守卫本身计入 unit 档）。

- [ ] **Step 4: Commit（红 tripwire）**

```bash
git add -- tests/infra/test-discovery-matrix.unit.test.ts
git commit -m "test(infra): add L1 test-discovery-matrix guard (red until orphans adopted)"
```

---

## Task 1b: 统一 e2e 发现为后缀过滤（修 BLOCK）

**根因**（已核实）：`test:e2e = bun test tests/e2e/`（目录过滤）不覆盖 `tests/e2e-client/anthropic-cli.e2e.test.ts`。改为后缀过滤 `.e2e.test`，并把 `tests/e2e/` 下 4 个裸 `.test.ts` 加 `.e2e` 后缀。

**Files:**
- Rename: `tests/e2e/copilot-api.test.ts` → `tests/e2e/copilot-api.e2e.test.ts`（及另 3 个：`extended-api`、`model-endpoint-completeness`、`model-resolution`）
- Modify: `package.json`（`test:e2e` 脚本，Task 2 一并；此处仅改名）

- [ ] **Step 1: git mv 四个 e2e 文件加后缀**

```bash
git mv tests/e2e/copilot-api.test.ts tests/e2e/copilot-api.e2e.test.ts
git mv tests/e2e/extended-api.test.ts tests/e2e/extended-api.e2e.test.ts
git mv tests/e2e/model-endpoint-completeness.test.ts tests/e2e/model-endpoint-completeness.e2e.test.ts
git mv tests/e2e/model-resolution.test.ts tests/e2e/model-resolution.e2e.test.ts
```

- [ ] **Step 2: 确认 `.e2e.test` 后缀过滤能命中全部 5 个 e2e 文件**

Run: `bun test .e2e.test 2>&1 | grep -E "across [0-9]+ files|Ran"`
Expected: 发现 5 个文件（tests/e2e/ 4 + tests/e2e-client/anthropic-cli 1）。注：e2e 需真 GHC token，无 token 时可能 fail/skip——本 step 只验**发现集**（文件数），不验通过。

- [ ] **Step 3: Commit**

```bash
git add -- tests/e2e/
git commit -m "refactor(test): rename tests/e2e/* to .e2e.test suffix for uniform discovery"
```

---

## Task 2: package.json 脚本分档改动

**Files:**
- Modify: `package.json:54-71`（test 相关脚本）

**Interfaces:**
- Produces: `test`=fast(unit+http)、`test:fast`、`test:e2e`(后缀过滤)、`test:cov`去内联漂移、`test:ci`扩全量、`test:all`/`test:acceptance`补 ui-v4

- [ ] **Step 1: 改脚本块**

把 `package.json` 中相关脚本改为（保留其它不变）：

```json
    "test": "bun run test:fast",
    "test:fast": "bun test .unit.test .http.test",
    "test:backend": "bun test .unit.test .it.test .http.test",
    "test:unit": "bun test .unit.test",
    "test:it": "bun test .it.test",
    "test:http": "bun test .http.test",
    "test:pty": "bun test .pty.test",
    "test:e2e": "bun test .e2e.test",
    "test:cov": "bun run test:backend --coverage",
    "test:cov:report": "bun run test:backend --coverage --coverage-reporter lcov",
    "test:ci": "bun run test:backend && bun run test:pty && bun run test:e2e",
    "test:all": "bun run test:backend && bun run test:ui && bun run test:ui-v4",
    "test:acceptance": "bun run test:backend && bun run test:ui && bun run test:ui-v4 && bun run test:e2e-ui",
```

注意：
- `test:cov`/`test:cov:report` 改为复用 `test:backend`（消除内联文件列表漂移）。**先验证** `bun run test:backend --coverage` 的 `--coverage` flag 能透传（bun run 会把额外 arg 附加到脚本命令末尾）。若不透传，退回内联但与 backend 同列表：`bun test --coverage .unit.test .it.test .http.test`。
- `test:e2e` 无 token 会红——`test:ci` 纳入 e2e 前需 Task 2b 的 token-gated skip；若本阶段 e2e 尚未 gated，`test:ci` 暂设为 `test:backend && test:pty`，Task 2b 完成后再加 e2e（记于 step 3）。

- [ ] **Step 2: 验证 fast 档发现集 = unit+http、不含 it**

Run: `bun test .unit.test .http.test 2>&1 | grep -E "across [0-9]+ files"`
Expected: 326 files（unit 265 + http 61）。

- [ ] **Step 3: 验证 `test:cov` 的 --coverage 透传（用副作用，非「有无覆盖率输出」）**

⚠️ bunfig `[test] coverage=true` **无条件开覆盖率**——`bun run test:unit`（不带任何 flag）已打印覆盖率表。故「有无覆盖率输出」是**假阳 oracle**（恒真、测不出透传）。改用**自定义目录副作用**判定：

Run: `rm -rf /tmp/covprobe && bun run test:cov --coverage-dir=/tmp/covprobe -- tests/infra/resetters-complete.unit.test.ts 2>&1 | tail -2 && ls /tmp/covprobe 2>/dev/null && echo "PASSTHRU-OK"`
Expected: 若 `/tmp/covprobe` 被创建并出现 `PASSTHRU-OK` → `--coverage-dir` 真透传到底层 `bun test`，`bun run test:backend --coverage` 形式成立。若目录未创建（覆盖率仍落默认 `coverage/`）→ 透传失败，按 Step 1 备选改内联 `bun test --coverage .unit.test .it.test .http.test`（列表与 backend 同源）。

Run（同时定 `test:ci`）：据 Task 2b（e2e 早已 gated）确认 `test:ci` = `test:backend && test:pty && test:e2e`；若担心本 step 时序在 Task 2b 之前，可暂设 `test:ci` = `test:backend && test:pty`，Task 2b Step 2 再补 e2e。

- [ ] **Step 4: Commit**

```bash
git add -- package.json
git commit -m "feat(test): tier scripts by speed — default test=fast (unit+http)"
```

---

## Task 2b: 验证 e2e 已 token-gated + 落定 test:ci 含 e2e（既成事实，非新增）

**现状（已核实）**：e2e **早已 token-gated**，无需新增 skip 逻辑：
- `tests/e2e/*.e2e.test.ts` 自 commit `c1589b00`(2026-02-07) 起用 `const describeWithToken = getE2EMode() !== "mock" ? describe : describe.skip`（`getE2EMode` from `tests/e2e/config.ts`）。
- `tests/e2e-client/anthropic-cli.e2e.test.ts` 用 `const GATED = Boolean(Bun.which("claude")) && existsSync(realGithubTokenPath())` + `describe.skipIf(!GATED)`。
- 实测干净环境（无 token）`bun test .e2e.test` → 全 skip / 0 fail。

故本 task 只做**验证 + 落定 test:ci**，**不新增任何 gating 代码**（照字面加 gate 会与既有 `describeWithToken`/`GATED` 重复冲突）。

**Files:**
- 无代码改动（除 Task 2 已改的 `package.json` `test:ci`）

- [ ] **Step 1: 验证干净环境 e2e 全 skip 不 fail**

Run: `env -u GITHUB_TOKEN HOME=/tmp/fakehome bun test .e2e.test 2>&1 | grep -E "skip|pass|fail|Ran"`
Expected: 全 skip、0 fail（无 token 环境）。若出现 fail → 停，说明某 e2e 文件漏 gate，逐个补 `describe.skip`/`skipIf`（此时才需改代码）。

- [ ] **Step 2: 落定 test:ci 含 e2e**

若 Task 2 Step 3 曾暂设 `test:ci` 不含 e2e，此处改回 `bun run test:backend && bun run test:pty && bun run test:e2e`，并跑 `env -u GITHUB_TOKEN HOME=/tmp/fakehome bun run test:ci 2>&1 | tail -5` 确认干净环境 e2e 段全 skip 不 fail（backend/pty 段正常绿）。

- [ ] **Step 3: Commit（若 Step 2 改了 package.json）**

```bash
git add -- package.json
git commit -m "test(ci): include token-gated e2e in test:ci (already gated, verified clean-env skip)"
```

---

## Task 3: 收编 55 个孤儿（分类 + 改名 + src 迁移+import 改写）

**目的**：让每个孤儿归入某 tier、被脚本发现。Task 1a 的守卫是本 task 的验收 oracle（收编完转绿）。

**分类 rubric**（按真相域，非速度）：
- `.unit`：纯函数 / 转换 / codec / 累积器 / 纯逻辑，不起服务、不 fetch、不建 SSE 管线、不落盘。
- `.it`：跨模块集成——驱动 pipeline / 建 SSE 帧序 / 起 in-process 组件 / SQLite 落盘 / 多组件协作（含现 `.integration.`/`.sub.` 语义）。
- `.http`：打 HTTP 端点、断言 wire。
- `.e2e`：spawn 真服务/真客户端 SDK/CLI。

**批次划分**（按目录，逐批提交；每批：逐文件读→按 rubric 定后缀→`git mv`→跑新档→守卫重跑）：

**批 A — tests/anthropic/（14 个）**：多为 anthropic 流式/thinking 逻辑。逐个读 import 判：驱动 pipeline/建帧序→`.it`；纯 destack/strip/store 转换函数→`.unit`。`quarantine-e2e.test.ts` 名带 e2e 但实测 582ms/in-process→按实际（很可能 `.it`，**读确认无真 spawn** 再定）。

**批 B — tests/pipeline/（6 个）**：`buffered-*`/`retreat-anchor`/`client-sink`/`heartbeat-suspend`/`live-reconcile-collision-e2e`——多为管线集成→大概率 `.it`；`buffered-anchor-golden` 若是纯 golden 断言无管线→`.unit`。逐个读定。

**批 C — tests/responses/ + tests/chat-completions/ + tests/tui/（6 个；`.integration.`/`.sub.` 统一改 `.it`）**：
- `cc-buffered.integration.test.ts` → `cc-buffered.it.test.ts`
- `ws-buffered.integration.test.ts` → `ws-buffered.it.test.ts`
- `ws-buffered-close-timing.test.ts` → 读定（时序集成→`.it`）
- `upstream-ws-crash-safety.sub.test.ts` → `.it`（sub=集成子进程语义）
- `footer-live-attempt.integration.test.ts` / `log-line-color.integration.test.ts` → `.it`（TUI 集成）

**批 D — tests/config/ + tests/codec/ + tests/architecture/ + tests/openai/（7 个）**：`keepalive-mode*`/`buffered-retry-keys`（config 断言→读定 unit vs it）、`codec/anthropic/*`（`commit-boundaries`/`block-internal-release`，codec 转换→大概率 `.unit`）、`per-model-idle-transport-boundary`（架构边界→读定）、`cc-commit-boundaries`（读定）。

**批 E — tests/ 根目录散文件（9 个）**：`recording-usage`/`stream-accumulator-usage`/`usage-data-shape`/`ghc-usage`/`responses-to-cc-usage`/`gemini-stream-cache-write`/`usage-normalize`/`message-tools-cc-tool-inventory`/`migration-cache-write-backfilled`——usage/accumulator 多为纯转换→`.unit`；`migration-*` 涉 SQLite→`.it`。逐个读定，并从 tests 根移进恰当子目录（可选，保持整洁）。

**批 F — src/ 13 个（迁移 + import 改写）**：全部 `git mv` 到 `tests/` 镜像路径 + 后缀，并把相对 import 改 `~/` alias。逐文件：

| src 旧路径 | tests 新路径（后缀待读定） | import 改写 |
|---|---|---|
| `src/lib/history/accumulate-response.test.ts` | `tests/history/accumulate-response.<suf>.test.ts` | `./x`→`~/lib/history/x` |
| `src/lib/history/in-flight-response-preview.test.ts` | `tests/history/in-flight-response-preview.<suf>.test.ts` | 同上 |
| `src/lib/history/response-preview.test.ts` | `tests/history/response-preview.<suf>.test.ts` | 同上 |
| `src/lib/history/sqlite/calibration-backfill.test.ts` | `tests/history/sqlite/calibration-backfill.it.test.ts`（SQLite→it） | `./x`→`~/lib/history/sqlite/x` |
| `src/lib/history/sqlite/response-preview-backfill.test.ts` | `tests/history/sqlite/response-preview-backfill.it.test.ts` | 同上 |
| `src/lib/history/sqlite/response-preview-column.test.ts` | `tests/history/sqlite/response-preview-column.it.test.ts` | 同上 |
| `src/lib/models/calibration/engine.consumers.test.ts` | `tests/models/calibration/engine.consumers.<suf>.test.ts` | `./engine`→`~/lib/models/calibration/engine` |
| `src/lib/models/calibration/engine.factor-model.test.ts` | 同目录 `.<suf>` | 同上 |
| `src/lib/models/calibration/engine.persist.test.ts` | 同目录（persist→可能 it） | 同上 |
| `src/lib/observability/active-request-wire.test.ts` | `tests/observability/active-request-wire.<suf>.test.ts` | `./x`→`~/lib/observability/x` |
| `src/lib/observability/sinks/calibration.test.ts` | `tests/observability/sinks/calibration.<suf>.test.ts` | `./calibration`→`~/lib/observability/sinks/calibration` |
| `src/lib/observability/sinks/calibration-failure.test.ts` | 同目录 | `./calibration-failure`→`~/lib/observability/sinks/calibration-failure` |
| `src/lib/pipeline/request-timing.test.ts` | `tests/pipeline/request-timing.<suf>.test.ts` | `./x`→`~/lib/pipeline/x` |

`<suf>` 逐文件按 rubric 读定。

**每批的步骤模板（对每批 X 重复）：**

- [ ] **Step X.1: 逐文件读 import + 断言，按 rubric 定后缀**（记录每文件裁决理由，尤其 `.unit` vs `.it` 的分界证据）
- [ ] **Step X.2: `git mv` 改名/迁移**（src 批同时改 import 为 `~/` alias）
- [ ] **Step X.3: 跑迁移后文件确认可发现可过**：`bun test <新路径>` → PASS
- [ ] **Step X.4: 该文件所属新档回归**：如归 `.it` 则 `bun run test:it` 局部无新失败
- [ ] **Step X.5: Commit**：`git add -- <本批精确路径>` + `git commit -m "refactor(test): adopt <批> orphans into tier suffixes"`

- [ ] **Step Z（全批完成后）: 守卫转绿 + src 空**

Run: `bun test tests/infra/test-discovery-matrix.unit.test.ts`
Expected: PASS（两 test 皆绿）。
Run: `find src -name '*.test.ts'`
Expected: 空。
Run: `find tests -name '*.test.ts' | grep -vE '\.(unit|it|http|pty|e2e)\.test\.ts$'`
Expected: 空。

- [ ] **Step Z.2: typecheck（迁移+import 改写后）**

Run: `bun run typecheck`
Expected: 0 error。

---

## Task 4: 慢离群审查（守后缀=类型硬规则）

**Files:**
- Read: `tests/pipeline/request-payload.unit.test.ts`、`tests/shutdown/rate-limiter.unit.test.ts`、`tests/shutdown/shutdown.unit.test.ts` 及其被测实现
- Modify（视裁决）：改名 `.unit→.it` 或加注释

**唯一改名充分条件**：实测确认做真 I/O/spawn/起服务。

**前置**：Task 2 的 `test:fast`/`test:it` 脚本已就绪（本 task 在 Task 2、Task 3 之后执行）。

- [ ] **Step 1: request-payload（5.3s/3测试）——读它为何慢**

读文件全文 + 被测实现。判：若构造大 payload 做纯计算/序列化（无 spawn/fetch/server）→ **留 unit**，在文件头加注释：`// slow (~5s): heavy payload construction, pure — stays unit per suffix=truth-domain rule`。若实际起服务/打端点 → 改 `.it`（`git mv` + 相应 import 无变）。

- [ ] **Step 2: rate-limiter（2.15s）+ shutdown（1.27s）——同法裁决**

读实现。rate-limiter/shutdown 多为定时器/并发逻辑——若用真 `setTimeout` 等待（非 fake timers）致慢但仍是纯逻辑 → 留 unit + 注释，并记 backlog「可用 fake timers 提速」（`docs/todo/deferred-backlog.md`，不阻塞本次）。若驱动真 server 生命周期 → `.it`。

- [ ] **Step 3: 每个裁决后跑对应档确认**

Run: `bun run test:fast`（若留 unit）或 `bun run test:it`（若改名）
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add -- <裁决涉及的精确路径>
git commit -m "refactor(test): audit slow unit outliers — reclassify genuine integration, annotate CPU-heavy"
```

---

## Task 5: 文档同步（含裸 bun test 语义审计）

**Files:**
- Modify: `CLAUDE.md`（工程纪律段）
- Modify: `docs/coding-conventions.md`
- Modify: 非归档 docs 中语义为「全量」的裸 `bun test`（逐处 requalify）
- Modify（可能）：`docs/DESIGN.md`「活的架构现状」若有测试脚本相关行

- [ ] **Step 1: CLAUDE.md 补分档纪律**

在「工程纪律 · 细粒度提交」段旁加一条，说明：默认 `bun run test`=fast（unit+http，仅快速反馈、**不是全后端验证**）；pre-push/交付前用 `bun run test:backend`（全后端）；`test:it`/`test:pty`/`test:e2e` 按需；后缀=真相域、tier=脚本组合、L1 守卫 `test-discovery-matrix` 防孤儿。

- [ ] **Step 2: coding-conventions.md 补两轴说明**

补：type 后缀集 `{unit,it,http,pty,e2e}` 及各自真相域；tier↔type 映射表；「改名唯一充分条件」硬规则；发现矩阵守卫。

- [ ] **Step 3: 非归档 docs 裸 bun test 语义审计**

Run: `grep -rn "bun test" docs --include=*.md | grep -v "docs/archive/" | grep -vE "test:(unit|it|http|pty|e2e|backend|ci|all|cov|ui)"`
逐条判：语义为「全量/全后端/commit invariant/提交前验证」者（如 `docs/rfc/2026-07-07-history-data-model-restructure.md:203`、`docs/2606-bridge-features/design.md:279`、`docs/spec/activity-detail-main-outline.md:654`）→ 改 `bun run test:backend`。指向具体单文件的 `bun test <path>` → 保留。**逐处人工判语义，勿全局 sed**（会误伤单文件脚本引用）。

**规模预期**：裸 `bun test` 命中约 135 个文件，但**绝大多数是历史 plan/kickoff/task-report 里的具体测试路径调用（`bun test <path>`），保留不动**；真正需 requalify 的只是描述「全量/全后端验证」语义的少数句子（十几处量级）。甄别规则：`docs/plan/*/`、历史叙事类文档里的具体命令引用几乎都跳过；只精读 RFC「commit 不变量」、spec「提交前全绿」、design「验证路径」这类**把裸 `bun test` 当全量门**的语义句。别被 135 这个数吓到逐个大改。

- [ ] **Step 4: Commit**

```bash
git add -- CLAUDE.md docs/coding-conventions.md docs/rfc/ docs/spec/ docs/2606-bridge-features/
git commit -m "docs: document test tiering + requalify bare 'bun test' meaning full verification"
```

---

## Task 6: 合并态验收（whole-branch）

**目的**：逐 task 绿 ≠ 合并态绿。跑全量确认集成无缝。

- [ ] **Step 1: fast 档 median（≥5 次）**

Run（连跑 5 次记 wall）：`for i in 1 2 3 4 5; do /usr/bin/time -v bun run test:fast 2>&1 | grep Elapsed; done`
Expected: 全绿；median 显著低于 `test:backend`（记入 plan 收尾/记忆）。

- [ ] **Step 2: 全档各自绿**

Run: `bun run test:backend`（unit+it+http 全绿）；`bun run test:pty`；`bun test .e2e.test`（无 token 全 skip 不 fail）。

- [ ] **Step 3: oracle 全过**

Run: `bun test tests/infra/test-discovery-matrix.unit.test.ts`（PASS）；`find src -name '*.test.ts'`（空）；`bun run typecheck`（0 error）。

- [ ] **Step 4: 派 subagent 合并态 review**（异模型，显式裁判轴：长远正确+完整；重点查集成缝——脚本语义是否自洽、有无新孤儿、doc-vs-code 一致、e2e gating 干净环境真不 fail）。处理 finding 后再收尾。

---

## Self-Review（plan vs spec 覆盖对账）

- spec §4.1 e2e 统一 → Task 1b ✓
- spec §4.2 脚本表 → Task 2 ✓（含 test:cov/test:ci/test:all/ui-v4）
- spec §4 e2e 入 ci 前提（方案 a token-gate）→ Task 2b ✓
- spec §5 收编 60 孤儿（分类/`.integration→.it`/src 迁移+import）→ Task 3 批 A-F ✓（55 待分类 + 4 e2e 已在 Task 1b + anthropic-cli 已 .e2e）
- spec §6 慢离群审查 → Task 4 ✓
- spec §7 P0a/P0b → Task 0a/0b ✓（分具名裁决，supply 不删）
- spec §8 L1 发现矩阵守卫 → Task 1a ✓
- spec §9 文档同步 + 裸 bun test 审计 → Task 5 ✓
- spec §10 验收 oracle → Task 3 Step Z + Task 6 ✓
- spec §12 阶段顺序（先守卫+e2e 边界，再改默认，后迁孤儿）→ Task 0→1→2→3→4→5→6 ✓（P0 前置在最前，守卫 1a 先立）

无占位符；类型/脚本名跨 task 一致（`test:fast`/`test:backend`/`.e2e.test`/`resetReaperDiagnosticsForTests`/`test-discovery-matrix`）。

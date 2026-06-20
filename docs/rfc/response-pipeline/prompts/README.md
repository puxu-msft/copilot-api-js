# Stage A — Phase Kick-off Prompts

每个文件是一个**可直接粘给独立实现者的完整 kick-off prompt**（仿 [docs/v4/prompts](../../../v4/prompts/) 结构）。按 phase 顺序执行，每个 phase 一个或多个会话。

| Prompt | Phase | 前置 |
|---|---|---|
| [phase-0-golden-baseline.md](./phase-0-golden-baseline.md) | Task 0：激活态 golden 基线 | 无 |
| [phase-1-flushchain-finally.md](./phase-1-flushchain-finally.md) | Task 1：flushChain 进 try/finally（H3 前置） | Phase 0 |
| [phase-2-request-side.md](./phase-2-request-side.md) | Task 2（A0）：请求改写迁进 driver S3 | Phase 0（独立、最低风险，可先行） |
| [phase-3-buffer-contract.md](./phase-3-buffer-contract.md) | Task 3：双 buffer 确定契约 + 映射规约 | Phase 0 |
| [phase-4-atomic-response-set.md](./phase-4-atomic-response-set.md) | Task 4（A1）：原子迁 Anthropic 响应改写集（最 byte-critical） | Phase 0/1/3 |
| [phase-5-nonstreaming.md](./phase-5-nonstreaming.md) | Task 5（A.B）：非流式 transformWhole | Phase 4 |
| [phase-6-responses-ws.md](./phase-6-responses-ws.md) | Task 6（A.C）：Responses 逐帧改写 + WS | Phase 0/1 |
| [phase-7-wrapup.md](./phase-7-wrapup.md) | Task 7：收尾 + 重走 OQ1 | Phase 0-6 |

> **设计稿**：[../design.md](../design.md)（RFC，§3 接口 / §4 Stage A / §7 验证 / §8 deferred 关系）。**实现计划**：[../stage-a-plan.md](../stage-a-plan.md)（master plan，每 Task 的 TDD 步骤 + factory 锚点表）。

## 阶段依赖 DAG（排实现者参考）

```
Phase 0 (golden 基线) ──► 一切的前置(所有迁移的字节等价基准)
Phase 2 (A0 请求侧)   ──► 独立、最低风险，可最先并行(OQ2:可独立先行)
Phase 1 (flushChain-finally) ──► Phase 3 ──► Phase 4 (A1 原子迁) ──► Phase 5 (A.B 非流式)   [Anthropic 响应链，严格串行]
Phase 0 + Phase 1 ──► Phase 6 (A.C Responses/WS)   [非 buffer，与 Anthropic 链格式独立]
Phase 0-6 ──► Phase 7 (收尾)
```

**并行边界**：Phase 2（请求侧）、Anthropic 响应链（1→3→4→5）、Responses/WS（6）格式上独立可分派给不同实现者，但都**改共享文件** `rewrite-registry.ts`/`driver.ts`/`types.ts`——需协调合并顺序（建议 driver/types 接口改动先合，registry 各格式分支填充后合）。Anthropic 响应链内部 **1→3→4 严格串行、不可并行**（byte-critical 顺序契约）。

## 通用红线（每个 phase 都遵守，复制进实现会话或依赖项目 CLAUDE.md）

1. **中文对话**回答与思考。
2. **绝不**未经同意 `git checkout/restore <file>`、`reset --hard`、`clean -f`、`rm` 工作区文件（不可逆，原则1）；删源文件用 `git rm`（无 -f 自保护）且仅在确认 committed-clean 时。
3. `git add`/本地 `commit` 允许；`push`/改写已推送历史/`gh pr` 需明确同意。**细粒度暂存**：`git add -- <精确路径>`，**绝不** `-A`/`-am`；提交前 `git diff --cached --stat` 复核仅含本次改动。
4. **不自动启服务器**（`bun run dev`/`start`）、不 `kill`/`pkill` 本项目进程。验证用 `bun run typecheck`、`bun run test:backend`、`bunx eslint --fix`（**不用 `prettier --write`**）。
5. **byte-critical 核心纪律**：每个迁移**先 golden-fixture-pre-capture**（在**改动前**的代码上锁字节，Phase 0 已建基线 + 各 phase 自捕该场景），改后**逐字节 golden 等价是硬 gate**，diff 即 fail。流式/时序 fixture 连跑 10-25× 确认确定性。
6. **修复后必做 subagent 对抗 review**（多视角），并**亲自复核 reviewer 引用的每个 file:line**（原则6，不信声音权威）。**派 subagent 一律用全量工具类型**（`claude`/`general-purpose`，非 `ecc:architect` 受限），prompt 里写"只读"作行为约束但工具不设限。
7. 测试隔离：DI/fetch-mock，**不用 `mock.module`**；mutate 全局 state 用 `autoRestoreState()`；fs I/O 用注入临时目录，**绝不碰真实 `$HOME`/`~/.claude`**。
8. 不使用分号、三元行首、`printWidth` 160；严格 TS、避免 `any`；同目录导入相对路径；不删有意义注释。
9. 不忽视既有错误（原则10）——遇到的所有 typecheck/test/import 错误都修。
10. 三大能力守卫每 commit 必过：`/history/api/entries/:id` 双轨、`/api/logs`+`/api/status` 形状、WS wire 协议不变。

## 通用必读（每个 phase 开场先读，复核 file:line——代码会漂移）

```
docs/rfc/response-pipeline/design.md          # RFC 设计稿(§3 接口/§4 Stage A/§7 验证/§8 deferred 关系)
docs/rfc/response-pipeline/stage-a-plan.md     # master plan(本 phase 对应 Task 的 TDD 步骤 + factory 锚点表)
docs/v4/05-progress.md                         # v4 deferred items(P3.2b-D1/P1.5-OQ1/P2.1-M2/P2.2-D1 是本重构来由)
docs/DESIGN.md                                 # v4 七阶段管线现状
```

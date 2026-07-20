# Task 6 报告：Phase 6（GATED）post-commit 截断类契约骨架

**状态**：完成（骨架落地，不实现功能代码，符合 GATED 授权范围）。

## 做了什么

1. 先读 `docs/spec/2026-07-11-block-level-buffered-retry.md` §5.1/§5.2/§9.2/§9.3 + `docs/plan/2026-07-11-block-level-buffered-retry/plan-1-anthropic-block-level.md` Task 6，核实 P1 的真实契约点（不臆造）：
   - `anthropicCommitBoundaries(frame): boolean`（`src/lib/codec/anthropic/commit-boundaries.ts`，P1 Task 1）
   - `handler-v4.ts` (~:1121) 传 `commitBoundaries` 进 `driver.runResponseBufferedSink(...)`（P1 Task 6 Step 3）
   - 新终局 `partial-degrade`（§9.2）+ History 记账须走 `writeSynthetic → recordForwarded → ctx.fail` 顺序（§9.3，P1 Task 6 Step 5）
   - 确认 P1 **尚未合入 master**（`.worktrees/block-level-buffered-retry` 分支 `feat/block-level-buffered-retry` 独立存在，`git merge-base --is-ancestor <tip> master` 返回 false）——本 Phase 保持 GATED 是正确判断，非过度谨慎。
2. 新增单一测试骨架文件 `tests/routes/messages/postcommit-truncation-shaping.it.test.ts`：整个 `describe.skip`，内含 `describe.each(["empty_text","ping"])`（落地评审 LOW-1 双 keepalive 模式覆盖要求）× 3 条 `test.skip` 占位：
   - 首块前 RST/截断 → block-level 判定可重放 → decide() 从未被调用
   - 首块后截断 → partial-degrade → 终局帧须为 `buildCanonicalErrorFrame` 产出（G-3）
   - `errorShapingEnabled=false` → P1 独立行为不变（golden 锁）
3. 未按需求单草稿的 `~~tests/support/isolated-runtime` 路径写（该路径不存在）——改用本仓库真实约定 `../../helpers/isolated-fixture` 的 `useIsolatedRuntime()`，并核实 `setStateForTests({ errorShapingEnabled })` 是本项目实际的状态注入方式（对照 Phase 3 `postcommit-error-shaping.it.test.ts` 的真实写法）。
4. `bun run typecheck` 全绿、`bunx eslint <新文件> --no-cache` 零错误、`bun test <新文件>` 结果 `0 pass / 7 skip / 0 fail`（无假绿假红）。
5. `git diff --stat` 确认无任何生产代码改动，只有一个新增未跟踪测试文件。

## 与需求单的偏差 / concerns

- 需求单骨架代码里的 `import { useIsolatedRuntime } from "~~tests/support/isolated-runtime"` 与 `state.errorShapingEnabled = true`（直接赋值）两处均与本仓库真实约定不符（真实路径是 `../../helpers/isolated-fixture`；状态注入走 `setStateForTests()` 而非直接改 `state` 单例）。已按真实代码调整，不影响契约本身。
- 因测试体全部是 `describe.skip`/占位 `expect(true).toBe(true)`，未实际 import `setStateForTests`（会触发 TS6133 未使用），改为在注释里保留调用示例文案，留给 P1 落地后取消 skip 时再引入真实 import。
- P0 检查清单第 4 项（双 keepalive 模式覆盖）已经在骨架结构里落地为 `describe.each`，但由于是 GATED 骨架，实际驱动 fixture 的代码尚不存在，等 P1 落地后开工时按此结构直接填充测试体即可，无需重新设计分层。

## Commit

（见下方返回消息中的短哈希）

# Command algebra final candidate merged-state review

> ⚠️ **2026-08-09 追加的口径更正（不改本报告当时的结论，只界定其证据强度）**：本文若把「16 份 shard JUnit 叶节点复算」或「磁盘 glob × JUnit 对账」称作**交叉验证／独立重算／独立 oracle**，那个措辞**不准确**——前者与 runner tally 同出一批 artifact、同一个 producer，只是换了 parser（抓解析／聚合错误，抓不到 producer 漏项）；后者独立于 runner 的**实现**、不独立于 discovery 的**规则**，且只到文件级。因此据此冻结的 `minimum_executed` 是**已观察量的地板**，不是「测试没减少」的证明。当前口径与判独立性的方法见 `docs/coding-conventions.md`「并行执行」节。

## 评审结论

- **评审范围**：候选 `16b494d301113fae7cd50a7aa499931dff5dab26`，评审包 `/home/xp/src/copilot-api-js/.claude/worktrees/command-algebra-calibration-flake/.superpowers/sdd/review-ebc8fffb..16b494d3.diff`，并以最终代码、`/home/xp/src/copilot-api-js/.claude/worktrees/command-algebra-calibration-flake/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md` Commit -1／§0.4f、`/home/xp/src/copilot-api-js/.claude/worktrees/command-algebra-calibration-flake/docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md` T1 为 oracle。
- **总体 verdict**：**可合并**。spec compliance：**通过／可合**。code quality：**通过／可合**。
- **blocker 数**：0。**major 数**：0。
- **结构怪味扫描**：扫描 persistence 两个 writer/test hook、resetter completeness guard、discovery baseline/schema guard、候选 merge 接缝与 HANDOVER 状态接缝；按重复实现、职责错位、抽象泄漏、双源弱实现判据，未发现 blocker／major 级结构怪味。两个领域 hook 形状相似但各自贴近不同持久化 owner，不构成本轮应抽取的共享机制；处置：无需整改。
- **第三方替代审视**：改动是现有 serialized writer 的确定性测试 seam 与既有 manifest guard 对账，不存在成熟第三方库可替代而当前又手搓的 blocker／major 机制。

## 双视角覆盖证据

- **机械核对**：读取目标 worktree 的 `.git` 与对应 ref，确认 ref 精确为 `16b494d301113fae7cd50a7aa499931dff5dab26`；核父图、两条 ancestry、`ebc8fffb..16b494d3` 路径集、两个关键 gate blob、EXEMPT、baseline membership、HANDOVER pointer 缺席与文档状态；运行 typecheck、6-file focused、persistence 10×、两个 guard、runtime dependency 重生成／blob 比较、backend，并执行 `git diff --check`。
- **第一人称执行模拟**：按 T1 从“候选尚在特性分支”走到未来 fast-forward/merge 才定义 A；分别模拟 frozen、reset-unfrozen、SIGINT、SIGUSR2 六条 persistence 流程；模拟“freeze 后错误安排 timer”的 false-green、正确 no-op 的 false-red，以及“新增 test file 未写 baseline”的 discovery 漏收路径；最后模拟 post-merge 前置条件，确认 candidate 阶段不能生成真实 pointer/evidence。

## 环境与 HEAD 证据

执行环境将 reviewer 隔离在另一 worktree，直接对目标 worktree 执行 `git ... HEAD` 被 harness 拒绝；因此没有把 reviewer 自己的 `0840b929` 冒充候选。目标路径与 HEAD 改由物理路径、gitdir、worktree ref 三项机械确认：

```text
pwd -P
/home/xp/src/copilot-api-js/.claude/worktrees/command-algebra-calibration-flake

/home/xp/src/copilot-api-js/.claude/worktrees/command-algebra-calibration-flake/.git
  gitdir: /home/xp/src/copilot-api-js/.git/worktrees/command-algebra-calibration-flake

/home/xp/src/copilot-api-js/.git/refs/heads/worktree-command-algebra-calibration-flake
  16b494d301113fae7cd50a7aa499931dff5dab26
```

候选对象输出：

```text
git log --oneline -1
16b494d3 merge: integrate latest entry gates (cutover-plan Commit -1)

git show --stat HEAD
commit 16b494d301113fae7cd50a7aa499931dff5dab26
Merge: 905eee1f ebc8fffb
Author: Pu Xu <puxu@microsoft.com>
Date:   Sat Aug 8 12:16:41 2026 +0000

    merge: integrate latest entry gates (cutover-plan Commit -1)

 ...-http2-cancel-provenance-and-header-deadline.md | 1053 ++++++++++++++++++++
 ...-http2-cancel-provenance-and-header-deadline.md |  247 +++++
 .../2026-08-07-http2-cancel-review-dispositions.md |   49 +
 tests/infra/entry-evidence-schema.unit.test.ts     |   17 +
 tests/infra/entry-test-discovery-baseline.json     |  283 +++++-
 5 files changed, 1620 insertions(+), 29 deletions(-)
```

## 当前状态命题核验

### C1 — 通过

- `git show -s --format='%H%n%P%n%s' 16b494d3` 给出父为 `905eee1f65b8a9cdf9e36fbebc914315e6343a54` 与 `ebc8fffb112e5ad73dc7119fafb7bce45c50df01`。
- `git merge-base --is-ancestor ebc8fffb 16b494d3` 与 `git merge-base --is-ancestor 905eee1f 16b494d3` 均为 YES。
- 当前 `master=0a21e9bef992d0572f154312e14df0c5c3a004bd`；`git merge-base --is-ancestor 16b494d3 master` 为 NO。故 candidate 尚未成为 master，未把 pointer P 当 A，也未提前产生 A；这与 `/home/xp/src/copilot-api-js/.claude/worktrees/command-algebra-calibration-flake/docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md:86-90` 的 T1 状态一致。

### C2 — 通过

`git diff --name-status ebc8fffb..16b494d3` 精确为以下 6 路径：5 个 persistence 修复路径加 1 个 review artifact。

```text
A docs/tmp/2026-08-08-command-algebra-entry-gate-persistence-flake-review.md
A docs/tmp/2026-08-08-command-algebra-entry-gate-persistence-flake.md
M src/lib/anthropic/feature-negotiation.ts
M src/lib/models/calibration/engine.ts
M tests/infra/resetters-complete.unit.test.ts
M tests/restart/states-flush-freeze.it.test.ts
```

`entry-test-discovery-baseline.json` 的 ebc8fffb／16b494d3 blob 均为 `ac80a9f4fadf9652667e919525badf7f8d14f5fa`；`entry-evidence-schema.unit.test.ts` 两端 blob 均为 `bb5698eceb04b0b43576878c831d85dfcc30c91d`。因此 merge 没有静默覆盖二者；它保留了 ebc8fffb 侧最新 gate 内容。

### C3 — 通过

- `/home/xp/src/copilot-api-js/.claude/worktrees/command-algebra-calibration-flake/tests/infra/resetters-complete.unit.test.ts:91-93` 对两个新 `drainScheduled*ForTests` action hook 逐项具名 EXEMPT；`:153-169` 同时要求所有 test export 均已登记／豁免且不存在 stale entry。
- `/home/xp/src/copilot-api-js/.claude/worktrees/command-algebra-calibration-flake/tests/infra/entry-test-discovery-baseline.json:332,598` 分别包含 `resetters-complete.unit.test.ts` 与 `states-flush-freeze.it.test.ts`；`:319` 也包含 guard 自身 `entry-evidence-schema.unit.test.ts`。
- `/home/xp/src/copilot-api-js/.claude/worktrees/command-algebra-calibration-flake/tests/infra/entry-evidence-schema.unit.test.ts:10-20` 从磁盘重新枚举全部 unit/it/http 文件并与 baseline 精确相等，故 T0.0f 不会静默漏掉新增 persistence 测试文件。

### C4 — 通过

本 reviewer 对精确 candidate worktree 的当前运行证据：

```text
bun run --cwd <target> typecheck
exit 0

6 focused files
77 pass / 0 fail

states-flush-freeze.it.test.ts --rerun-each=10
60 pass / 0 fail

runtime dependency blob before/after
42808397184ff4e4cb94c6138308463db59ee68e
42808397184ff4e4cb94c6138308463db59ee68e

bun run --cwd <target> test:backend
16 shards · 6017 tests · 6017 pass · 0 fail · 7259 executed · 30 skipped · exit 0
```

调用方给出的同一候选单次观测是 `5848 pass / 0 fail / 7259 executed / 30 skipped`；当前 reviewer 环境得到 `6017 pass`，再次证实 reporter 的 tests/pass 会随环境变化。它不破坏 gate：版本化 baseline 的 `minimum_executed=7258`（`entry-test-discovery-baseline.json:3`），当前独立稳定量为 `7259 executed / 30 skipped`，并且 gate 还按 file identity 与 skip multiset 对账，而不是拿易漂的 tests/pass 当人口 SSOT。

### C5 — 通过

- 错误状态：`/home/xp/src/copilot-api-js/.claude/worktrees/command-algebra-calibration-flake/docs/tmp/2026-08-08-command-algebra-entry-gate-persistence-flake.md:14-16` 记录两个“freeze 后仍安排 timer”exact mutation 均在 boolean 处以 `Expected: false / Received: true` 转红；最终测试还在 `/home/xp/src/copilot-api-js/.claude/worktrees/command-algebra-calibration-flake/tests/restart/states-flush-freeze.it.test.ts:59-70,112-122` 核真实磁盘旧快照，不能只靠 boolean 假绿。
- 正确状态：reset/SIGINT 分支要求 hook 为 `true` 且新值实际落盘（同文件 `:73-90,125-144`）；SIGUSR2/frozen 分支要求 `false` 且新值不在磁盘（`:95-105,149-159`）。当前 10× 为 60/0，未见 false-red。
- discovery 漏收：若从 baseline 删除任一新增 test file，`entry-evidence-schema.unit.test.ts:10-20` 的完整集合相等断言必红；正确 baseline 当前与磁盘一致，guard 实跑合计 8 pass/0 fail。这里比较的是文件集合而非总数，能点出漏项。

### C6 — 通过

- `/home/xp/src/copilot-api-js/.claude/worktrees/command-algebra-calibration-flake/docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md:1-3,86-90` 仍明确“待正式合并”“A 不存在／待执行”；candidate 不在 master 上，因此状态诚实。
- 全文无 `entry-evidence-pointer:v1`、`entry_sha=`、`manifest_path=`、`manifest_sha256=`，没有提前写 post-merge evidence。
- `/home/xp/src/copilot-api-js/.claude/worktrees/command-algebra-calibration-flake/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:457,469-480` 明确 T0.0f/T0.0d 只能在正式合 master 得 A 后执行，candidate 当前没有越过该时序边界。

## 事实性发现

未发现 blocker／major。

## 主观建议

按调用方要求仅报告 blocker／major；无需要阻塞合并的主观建议。

# 合并后收尾补充产物独立评审

- **评审范围：** 固定 commit `971a3e39` 的新记忆条目与索引、`9c323128` 的状态更新、归档自测脚本和二次冻结临时清单；另按要求扫描固定 commit 的全部 `docs/` 与 `.claude/skills/`。评审期间共享 worktree 的 HEAD 被并发会话推进到 `bd00b710`，因此文本结论均以 `git show 971a3e39:<path>` 取证；`971a3e39..bd00b710` 只改记忆正文与终态报告，未改测试脚本或生产／测试代码。
- **已读取／执行的证据：** 读取全部指定文件及既有 `feedback-moving-shared-head-is-not-failure`；实跑 C1 两条命令、归档脚本、固定 commit 全仓状态词扫描、脚本与 plan 清单集合比较、链接目标检查、commit ancestry 与 14 个 commit 的 `%s` 检查。
- **总体 verdict：** 修复 major 后可进入下一阶段。
- **blocker 数量：** 0。

## 逐条核验

- **C1：成立。** `git show -s --format='%H%n%P%n%s' ad8128ad` 显示 merge commit `ad8128ade33fded2c93f2e7ec10bb310555b329b`，subject 为 `Merge branch 'worktree-fix-shutdown-review-findings'`；`git merge-base --is-ancestor 954a1bff master` 退出 0。`git branch -a --contains 954a1bff` 同时列出 `master`；`git show master:src/lib/shutdown.ts | grep -n 'getActive: ()'` 在第 306 行显示 generation 与 lightweight 两 registry 的并集。`/home/xp/src/copilot-api-js/.claude/worktrees/fix-shutdown-review-findings/docs/plan/2026-08-07-lossless-graceful-shutdown-drain.md:6` 的正向判定成立。
- **C2：不成立，仍有陈旧活断言。** 固定 commit 的本任务终态报告尚余两处，且全仓另有多个早已进入 master 却仍写“待合并”的活状态断言；详见 M1。
- **C3：成立。** 实跑 `/home/xp/src/copilot-api-js/.claude/worktrees/fix-shutdown-review-findings/docs/tmp/2026-08-08-lossless-shutdown-self-tests.sh`，输出 `file count: 12`、`100 pass`、`0 fail`、`Ran 100 tests across 12 files`。用独立 Python 集合比较脚本 `FILES` 与 plan 第 359 行展开后的清单，得到 `script_count 12`、`plan_count 12`、`only_script []`、`only_plan []`。
- **C4：部分成立。** 53／0／0 位于 job 目录外，无法独立核验。14 个列名 commit 均存在；抽查 6 个 `%s` 为 `b6f1f5e0 docs: 记录三路复评 PASS 与 validator 超时预算处置`、`b7e2cdec docs: 闭合 lint 外部阻塞并更新合入后验证快照`、`6adf2e56 docs: 归档无损 shutdown 的正控变异 patch 与 validator 计时证据`、`93de46b9 docs: 把无损 shutdown plan 转为终态记录`、`51d705cf docs(skill): 给 shutdown 正控记述补可复跑的 patch 指针`、`5405056b docs(memory): 记随机 false-red 挂在进程全局量上的两种形态`；但外部 `msg*.txt` 不可读取，不能验证“输入与 subject 相等”，详见 M3。
- **C5：除“八处已扫净”外，实证成立。** `9c323128^` 中四份文件确有八个目标状态位置；`ad8128ad` 与 blocker 理由可由 merge ancestry、master 合并前后的 `shutdown.ts` 形态及 `/home/xp/src/copilot-api-js/.claude/worktrees/fix-shutdown-review-findings/docs/tmp/2026-08-08-lossless-shutdown-closeout-docs-review.md:16` 对账。固定 commit 自身又漏了终态报告两处，故“`grep` 一次扫干净”被本轮反例推翻，详见 M1、M2。
- **C6：成立。** frontmatter `name` 与文件名 stem 都是 `methodology-closeout-doc-goes-stale-the-moment-the-merge-lands`；三个 `[[...]]` 目标文件均存在；`MEMORY.md:93` 的相对链接可解析到新文件。
- **规则冲突：不存在。** `/home/xp/src/copilot-api-js/.claude/worktrees/fix-shutdown-review-findings/docs/memory/methodology-closeout-doc-goes-stale-the-moment-the-merge-lands.md:22` 的区分站得住：新条款只要求刷新描述 merge 状态的文字，既有条款 `/home/xp/src/copilot-api-js/.claude/worktrees/fix-shutdown-review-findings/docs/memory/feedback-moving-shared-head-is-not-failure.md:7-11` 禁止的是仅因无关 HEAD 前进而重复全量复验；更新状态事实不等于重跑验收。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/fix-shutdown-review-findings/docs/tmp/2026-08-08-lossless-shutdown-terminal-report.md:35,99` — 固定 commit 仍残留两条本任务陈旧断言：“`77d6d479` 起的整改仍只在本分支”与 plan 状态头含“整改待合并”。— `git merge-base --is-ancestor 954a1bff master` 退出 0，且同报告 `:4,89` 已写整改由 `ad8128ad` 合入，形成文档内自相矛盾。— 删除／改正这两处，并重新按语义载体而非仅关键词复扫。

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/fix-shutdown-review-findings/docs/memory/project-history-search-out-of-process.md:3,15`、`docs/memory/project-responses-buffered-merge-landed.md:11`、`docs/memory/project-symmetric-four-point-hooks.md:10`、`docs/plan/monorepo-split/plan-telemetry-package.md:7` — C2 的全仓扫描还发现四组活状态仍称“待合并 master”。— `git merge-base --is-ancestor` 对 `30a483df`、`8e0376d4`、`2a77bf7c`、`bd3aafe0` 与 `master` 均退出 0；其中前三条还是每次加载的记忆正文。— 按各自权威现状改为已合入，并继续 disposition 其余命中，历史引文与活断言分开处理。

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/fix-shutdown-review-findings/docs/memory/methodology-closeout-doc-goes-stale-the-moment-the-merge-lands.md:17-20` — 判据可被“这不是我本轮写下的／用户没有回复‘已合并’／关键词没命中”合理化绕过，且“当场登记”没有登记位置、字段或闭合条件；“`grep` 一次扫干净”已被同一固定 commit 的 M1 直接证伪。— 把触发条件改为任何收尾事实发生或被检测到时，覆盖继承断言与转述；规定登记载体、owner、目标事实、复核命令、携带者集合与闭合标记，并要求关键词命中逐条 disposition，不能把零命中当完备性证明。

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/fix-shutdown-review-findings/docs/tmp/2026-08-08-lossless-shutdown-temp-manifest.md:2-6,37,42-46` — 清单把当前已无法独立核验的外部临时状态写成无条件“已核验”：53／0／0、无未分类项、14 个 `msg*.txt` 与 `%s` 逐条相等、PID 已退出及未触及其它数据。— 当前仓库只能验证 14 个 commit 及其 subject，不能验证外部输入文件、目录人口或当时进程／数据状态。— 将这些标为“会话作者当时自报、当前不可复核”，或把原始目录清单、14 组输入↔subject 对照与进程探针输出持久化后再保留“已核验”。

## 主观建议

无。

## 固定 commit `a47d9e11` 复评

- **M1：FIXED。** `/home/xp/src/copilot-api-js/.claude/worktrees/fix-shutdown-review-findings/docs/tmp/2026-08-08-lossless-shutdown-terminal-report.md:36` 已改为两批提交均进入 master，并给出 `git merge-base --is-ancestor 954a1bff master`；该命令退出 0。原 `:99` 残留已由 `f31d2bdd` 修正。
- **M2：FIXED。** 四处均改为“已合入 master”并保留原状态的时间语境与可复跑命令。实跑 `git merge-base --is-ancestor <sha> master`，`30a483df`、`8e0376d4`、`2a77bf7c`、`bd3aafe0` 四条均退出 0。改动只是依据 Git ancestry 更新可机械裁决的当前状态，不改变原任务结论、规格或取舍，因此不越界，也不需要原作者裁决。
- **M3：FIXED。** `/home/xp/src/copilot-api-js/.claude/worktrees/fix-shutdown-review-findings/docs/memory/methodology-closeout-doc-goes-stale-the-moment-the-merge-lands.md:18-21` 已覆盖“事实发生或被察觉”、非用户触发、继承断言、五字段登记载体、语义载体扫描、逐条 disposition 与“零命中不等于完备”，并纳入第十处反例。
- **M4：FIXED。** `/home/xp/src/copilot-api-js/.claude/worktrees/fix-shutdown-review-findings/docs/tmp/2026-08-08-lossless-shutdown-temp-manifest.md:7-18,51,57,60` 已把 53／0／0、无未分类项、`msg*.txt` 输入侧和进程／数据状态明确降为作者当时自报、当前不可复核，并写明升级所需持久化证据。
- **复评 verdict：** 可进入下一阶段；0 blocker／0 major。
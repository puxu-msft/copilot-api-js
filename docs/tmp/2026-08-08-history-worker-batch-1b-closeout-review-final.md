# History Worker Batch 1b 收尾证据独立评审

## 评审范围、证据与 verdict

- 评审对象：`/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-terminal-report.md`、`/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-temp-manifest.md`。
- 独立性：本评审者未参与 H1/H2/H3，不沿用此前 reviewer 结论。
- 最终复核时 worktree provenance：`pwd -P` 与 `git rev-parse --show-toplevel` 均为 `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume`；HEAD `922b741bf70720150d6a4ab2cd3b252d3f46ed25`，`master` `d1011fe7eb1f26c0c646b667164ddb0e4dd80bf0`。评审期间候选从 `d1011fe7` 前进到 `922b741b`，因此以下结论以最终文件与最终 Git 状态为准。
- 已读取／执行：两份对象全文；共享 type owner／V3 alias／Worker protocol 与 protocol test；候选 Git graph；shared working tree bytes、对象类型、mode 与 shared index 三方对账；56 项 temp disk↔manifest 逐路径对账；11 selectors 存在性；protocol unit test；live remote refs 与 GitHub PR 查询。
- **总体 verdict：修复 major 后可进入下一阶段。Blocker：0；Major：2。**

## D1 裁决：冻结门放宽

**裁决：成立但需附加条件。** 当前文本只写“字节总数变化只需说明来源”，不足以守住完整不变量；补齐下列条件后，路径集合可以作为“是否整表重新生成”的门。

1. 承重不变量不是单纯“每条路径有一行”，而是“清理时每个临时对象的当前内容仍被该行的长期价值分类、持久接收者／不可变替代证据、最终动作与清理前置覆盖，且需留存的新结论已经进入 durable receiver”。
2. 路径集合不变但内容变化时，必须定位到逐路径，而不是只解释 aggregate byte delta；复核该路径的 type、语义用途、长期价值、receiver／replacement 与 action 是否仍成立。全部不变时，只记录 delta 来源和复核结果，不必重新生成／复审其余行；任一项变化时，更新受影响行及引用它的报告结论，并复审受影响范围。
3. patch、原始测试证据、恢复副本、报告草稿等可能承载新 WIP／新结论的对象，不得仅凭“同一路径”放行；需要内容身份或语义复核。最终 cleanup 前仍须重枚举路径集合。

**false-green 反例：** `history-worker-batch-1b-wip.patch` 保持原路径，却被覆写为包含尚未提交的新修复；操作者只说明“同一路径重新生成 patch”。新规则原文允许通过，但 manifest `:48` 的“已提交实现／当前权威分支”receiver 已失真，job cleanup 会删除唯一 WIP；旧“总字节变化即回表复审”会拦住。故“来源说明”不能替代逐路径 receiver 复核。

**false-red 实例：** `shared-main-index.terminal-review.snapshot` 在同一路径按最新 shared index 重拍，431,277→431,517。独立检查确认它仍是同一用途的 index snapshot，13 条候选路径的 working tree、index 与当时 master 对账仍为零碰撞；用途、receiver、action 均未变。旧门只因总量 +240 就要求重生成／复审整张 56 行清单，拒绝的是正确状态，确属 false-red。本轮这 240 bytes 变化满足上述附加条件，但通用规则文本尚未写出条件。

## D2 裁决：清理前置链

**裁决：存在断口。** 报告 `:63-64` 对人工可控动作给出的顺序是：安装位置复验完成→终审 0 blocker／major→提交报告与清单→确认该提交是 master ancestor；此前禁止清理。问题是 manifest `:6` 与全部行把最终动作写成“保留至 Claude job 自动清理”，而 harness 自动 cleanup 不读取 Git ancestry 门。

具体绕过路径：第 5 步终审通过后，第 6 步提交或第二次 fast-forward／ancestry 确认尚未完成，session/job 因正常结束、崩溃或平台回收而终止；job 自动清理随后删除 56 项。此时收尾提交仍不在 master 祖先，收尾未闭合，但 temp evidence 已被清掉。更早终止也同样绕过；“不得允许”没有执行接缝，无法约束 harness 生命周期。

修复应把可控门与不可控 cleanup 分开：在 final review 前，先把所有仍有长期价值的 temp 内容持久化／蒸馏到 durable receiver，并把待审报告与 manifest 提交到受保留 branch；final review 锚定明确 commit，修订则新提交并复审。`master` ancestry 继续作为“可宣告集成完成、可清理 branch／worktree”的门。对 job 自动 cleanup，应诚实标为不可控生命周期事件，并保证它提前发生也不会删除唯一证据；不能声称 Git gate 能禁止它。若坚持“temp cleanup 必须晚于 master ancestry”，则需可显式 hold job 生命周期且经过验证的外部机制，当前产物没有。

## C1–C9 当前状态断言核验

- **C1：最终版本属实。** 报告 `:2-3` 写 `master@d1011fe7...`；最终命令 `git rev-parse HEAD master` 输出 `922b741b...` 与 `d1011fe7...`，报告明确说明最后一笔闭环提交仍待再次 fast-forward。初版所写 `0ecbca65` 已被当前版本替换。
- **C2：初版断言按其冻结基线属实。** 在 `0ecbca65` 上，`git rev-list --count master..0ecbca65` 为 15，merge 为 `0ecbca65`、`8f9a7214`、`926b2478`、`da1b6cc5` 四笔。当前报告已进入集成后状态，不再把“15 笔”冒充当前 HEAD 计数。
- **C3：初版 13 条属实，且当前报告正确限定为 fast-forward 前的 collision population。** 初审时 `git diff --name-status d47492a6..d1011fe7` 为 10 条 `M`＋3 条 `A`；最终 `master..HEAD` 只剩报告与 manifest 两条 `M`，符合报告 `:27`。
- **C4：零碰撞结论属实，但 md5 方法本身不覆盖完整 `git status` 语义。** 初审对 13 条净路径以 `os.lstat`、文件 bytes、master blob 与共享 `.git/index` 三方复核：10 条既有路径内容及 index blob 与 master 相等、均为 regular file mode `100644`；3 条新增路径在 shared FS 与 index 均不存在；候选没有 mode/type change。报告当前 `:34` 已诚实列出 mode、symlink、staged-only、候选外 untracked 的边界。独立补充检查排除了这些形态在本轮目标路径中的实际存在。
- **C5：属实。** `src/lib/history/persist-retry-config.ts:1-5` 是四字段唯一定义；`src/lib/history/v3/store.ts:8,163` import 后以 `V3PersistRetryConfig` 兼容别名复用；`src/lib/history/worker/protocol.ts:1-4,57-61` import／re-export 并用于 start config。候选内全仓 `rg` 未发现第二份定义。
- **C6：属实，测试对目标错误实现有鉴别力。** `src/lib/history/worker/protocol.ts:348-360` 要求 `maxAttempts` 为 positive integer，三个 cap 为 non-negative integer；缺失与负值均拒绝。`tests/history/worker/protocol.unit.test.ts:244-265` 有合法正样本，以及 `maxBackoffMs`、`maxTotalMs` 各自缺失／负值的负样本；删除任一目标 validator 后，对应 `toThrow` 会因不再抛错而红，不会由旁路断言代咬。实跑该文件：16 pass、0 fail、46 expect。
- **C7：属实。** Python `Path.rglob('*')`＋`os.lstat` 只计 regular file／symlink：disk 56 项、manifest 56 行、路径及类型集合完全相等。最终 disk 6,568,699 bytes；表格列仍合计 6,568,459，唯一 mismatch 是 `shared-main-index.terminal-review.snapshot` 的 431,517 vs 431,277，精确差 240，与头部 `:5,7` 一致。
- **C8：属实。** 从报告当前 `:73` 解析出 11 个 selector，候选 HEAD 上逐个 `Path.is_file()` 均为 true，不会因 selector 缺失而起步假红。报告记录安装位置实跑为 89 pass／0 fail；本轮只独立裁 selector 存在性，不把自己的候选 test run冒充共享安装位置证据。
- **C9：在可观测 Git／GitHub 表面属实。** `git branch -r --contains HEAD`、`git tag --points-at HEAD` 与联网 `git ls-remote --heads --tags origin` 对 `922b741b`／branch name 的筛选均零命中；此前对 `d1011fe7` 同样零命中。`gh pr list --repo puxu-msft/copilot-api-js --state all --head worktree-history-worker-batch-1b-resume` 返回 `[]`。“未发布任何 artifact”无法由 Git 穷尽所有外部系统，本结论限定为本仓库／GitHub 可观测范围。

## 事实性发现（仅 blocker／major）

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-temp-manifest.md:7` — 同路径内容变化只要求“说明来源”，不足以证明 disposition／receiver 仍覆盖当前内容 — 上述 WIP patch 覆写反例会在新门下放行并丢失唯一工作；当前 240-byte snapshot 又证明整表重做过严 — 按 D1 三项附加条件改成“逐变化路径语义复核；仅受影响范围更新与复审”。

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-terminal-report.md:63-64` 与 `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-temp-manifest.md:6` — Git 顺序门无法约束 Claude job 自动 cleanup，存在终审后、收尾提交进入 master 祖先前被平台清理的路径 — 将 durable receiver 的提交与验证前移，final review 锚定 commit；master ancestry 留作集成完成门，不要把不可控 harness cleanup 写成受该门控制。

## 结构怪味扫描

- `temp-manifest.md:7` — 怪味类型：同一不变量的弱一档复述；处置：本轮 major，须按 D1 修。
- `terminal-report.md:63-64`↔`temp-manifest.md:6` — 怪味类型：门与不可控执行机制脱节；处置：本轮 major，须按 D2 修。
- 扫描范围还包括四字段 owner／alias／protocol 接缝及 shared working tree／index collision 门；未发现额外 blocker／major 结构怪味。

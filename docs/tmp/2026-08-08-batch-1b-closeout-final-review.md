# Batch 1b 收尾终审

- **评审范围：** `review_temp_manifest` 与 `review_closeout_final`；对象为终态报告、56 项临时证据清单及其 Git／磁盘事实。
- **已读取／执行的证据：** 两份候选文档全文；`closing-a-development-session` stage contract；候选 `HEAD=9a6226b6df8542acd03a7030ddcb5bfb3fa39b5b`；`master=58f4c45d8010312991780e26466f65bb35bc32bf`；ancestry、branch、worktree、磁盘人口与 receiver 检查逐项见下。
- **总体 verdict：修复 major 后可进入下一阶段。**
- **blocker 数量：0。**

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-terminal-report.md:2,44,72,92-95,113` — 报告仍有第四组陈旧且相互矛盾的终态断言。行 2 声称“全部收尾证据已集成主线”，行 44 仍把已被本轮修订作废的旧 `closeout-review-final.md` 称为“终审报告”，行 113 又把“本报告与临时清单终审”标成已完成；但同一文件行 92、95 明确说清单重审和 draft/final review 未做，且 `git merge-base --is-ancestor a5ee292b master` 与 `git merge-base --is-ancestor 9a6226b6 master` 均为 exit 1。新加的 commit-relative 判定命令本身不会因 `master` 前进而陈旧，但它没有消除这些旁路断言。修复时把状态统一为“交付内容已集成；收尾产物待其最后修订 commit 进入 master”，并删除或改写旧终审已完成表项；本轮新评审只能在其报告提交后作为证据引用，不能继续预写成已落地。

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-terminal-report.md:76-77` — keep／keep 的“删除 worktree 会丢提交”理由不成立，且把可选保留写成了安全前置。候选初始 `git status --short --branch` 无改动；`git branch --contains 9a6226b6` 明确列出 `worktree-history-worker-batch-1b-resume`，所以 `HEAD` 已由 durable branch ref 可达，删除 worktree 本身不会删除该 branch 或丢 `9a6226b6`。`master` ancestry 是删除 branch／宣告集成的门，不是 worktree `head_reachable` 的唯一实现。修复建议：分开裁决——branch 在 `9a6226b6` 未进 `master` 时应 keep；worktree 的 clean、reachable 已成立，owned 若能由会话归属证据确认则已具备移除条件，但是否移除仍由用户决定，不能再声称必须等 fast-forward 才安全。

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-terminal-report.md:83-95` — 跳步表漏报 canonical stage，且把未达到前置的后续 stage 写成完成。`closing-a-development-session` 的 17 stages 还包括 `draft_terminal_report`、`verify_installed_location`、`recommend_assets`、`update_terminal_report`、`report_terminal`；表中没有逐项 disposition。更重要的是 contract 明定 `report_terminal` 依赖 `review_closeout_final`，而 `_final` 尚未做，所以当前报告不能被称为 terminal／reported；`review_closeout_draft` 未做时，依赖它的 `verify_installed_location` 也不能标成合规完成，即使某些安装位置命令确实跑过。修复建议：补齐全部 17 stage，区分“动作曾发生”与“按 contract 顺序完成”；至少把 `verify_installed_location` 标为顺序违规后补跑／证据可复用、`report_terminal` 标为未完成，并审查 `recommend_assets`、`update_terminal_report` 的实际先后。

[major] `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume/docs/tmp/2026-08-08-history-worker-batch-1b-temp-manifest.md:6,14,73` — 清单 disposition 与当前磁盘仍有一处不一致。两种枚举均得 56 项，路径集合、类型与其余 55 个 size 全匹配，实际总字节也确为 6,568,699；但 `shared-main-index.terminal-review.snapshot` 当前是 431,517 bytes，表中仍写 431,277，正好差 240 bytes。头部说已逐路径复核并非替代逐行事实更新；否则后来人按表重算只会得到 6,568,459，与头部当前总数冲突。修复建议：把行 73 更新为 431,517，并在改动后按清单自身规则重新触发受影响范围复审；本轮 `review_temp_manifest` 因此未通过。

## 已核对但未形成 major 的项目

- A5 抽查通过：`tests/infra/entry-test-discovery-baseline.json`、两份 Batch 1b evidence docs、`src/lib/history/worker/admission.ts`、`src/lib/history/persist-retry-config.ts` 均可由 `master` 读取；抽查提交消息 `fix(history): preserve overlay query invariants` 精确命中 `master` 祖先 `df0c7bf4`。未发现“零删除”导致唯一副本丢失。
- A6 false-red：manifest 的“任何路径名变化即整表重生成”虽然保守，但新增路径确实未经分类，属于合理 gate；真正过严的是报告把 worktree 可达性等同于 `master` ancestry，已列为 major。

## 主观建议

未发现需要单列的主观建议。

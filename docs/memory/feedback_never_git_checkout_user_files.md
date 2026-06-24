---
name: feedback_never_git_checkout_user_files
description: "判据是可恢复性:绝不 git checkout/restore/reset --hard/clean/stash drop,或 rm/覆盖带未暂存改动/未追踪的文件(git 救不回);但干净的已追踪文件用户明确要求时可删(历史可恢复)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d3484aff-0a7f-4ddf-80b9-248de8587aff
---

判据是**可恢复性**(git 救不救得回),不是"删不删文件"一刀切——本会话纠正的 CLAUDE.md `no-destructive-workspace-loss` 与此对齐。

**绝对禁止造成 git 救不回的工作丢失**:运行 `git checkout HEAD -- <file>` / `git checkout -- <file>` / `git restore <file>` / `git reset --hard` / `git clean -f` / `git stash drop`,或对**带未暂存修改**或**未追踪**(从未提交)的文件 `rm`/覆盖。这适用于**即使**:
- 我以为只是在回退我自己最近的编辑(如 lint --fix 的输出)
- 文件看起来只含我的改动
- 我确信用户"不会动过它"
- 这"只是回退一步而已"

**但删除一个干净(无未暂存改动)的已追踪文件是允许的**——git 历史可完整恢复:仅当**用户明确要求**移除时执行,先 `git status` / `git diff -- <精确路径>` 确认无未暂存改动,优先 `git rm`(暂存、可审计)。**绝不自作主张删**(以"清理死代码/无消费者"为名擅自删除仍禁止——该先问,或改为指向生产/转换而非删)。

**Why:** 我运行了 `git checkout HEAD -- src/lib/anthropic/auto-truncate.ts` 来撤销一次部分 `eslint --fix`,却没意识到该文件在最初 `git status` 里已是 `M`——用户在其中有预先存在的未暂存工作。这次 checkout 静默清除了他们的全部工作,**无任何备份**,不可逆。这才是真正的危险:丢弃工作树里 git 救不回的修改。**后续过度纠偏**:我曾把此教训误推广成"绝不删任何源文件,没有理由豁免",以致连用户**明确要求**删除的干净已追踪文件也拒删(把 over-coverage 测试文件强行"转换"而非删)——用户指出过度,判据应是**可恢复性**,已纠正。

**How to apply:**
1. 任何会丢弃工作树修改的操作前,先 `git status` / `git diff -- <file>` 查该文件。显示 `M` 或未追踪 → 有 git 救不回的内容,**绝不** checkout/restore/reset/clean/rm/覆盖它。
2. 撤销我自己的 lint/格式化改动:用 `Edit`/`Write` 重新编辑,或保留并告知用户"我做了这些编辑,无法在不冒险破坏你工作的前提下干净回退——请审阅,不需要请手动还原。"
3. 干净的已追踪文件,用户**明确要求**删除时可删(先确认无未暂存改动,优先 `git rm`);但绝不自作主张删,也绝不删**未追踪**文件(不可恢复)。
4. 某工具(如 `eslint --fix`)以我想撤销的方式改了许多文件 → **不要**批量 checkout/reset 回退,询问用户。

Linked: [[feedback_no_unilateral_action]] [[feedback-test-overlap-across-altitudes-is-allowed]]

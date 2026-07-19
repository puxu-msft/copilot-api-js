---
name: feedback-merger-yields-but-merge-must-happen
description: 并发会话落地时「谁合并谁退让、但必须合并」——退让指不 clobber 对方未提交改动、行级共存两份都保，而非跳过合并规避冲突
metadata: 
  node_type: memory
  type: feedback
  originSessionId: edeab356-7305-47dd-84b2-4629fdb4197b
  modified: 2026-07-18T22:35:16.472Z
---

并发多会话共享仓库里，当**我这一方要把工作合入 master**（FF / merge）而对方会话在同文件有未提交改动时：**谁执行合并谁退让，但合并必须发生**。

**Why:** 用户明确立规「永远记住这条规则，谁合并谁退让，但必须合并」。退让 ≠ 放弃合并——两者不可混淆：见到冲突就「不 FF、留分支给你自落」是**错的**（那是跳过合并规避冲突）；正确是**照样合并、只是在冲突处让对方的改动赢/共存**。这与项目 `concurrent-sessions 行级共存`（CLAUDE.md）一脉相承：功能不矛盾则两份都落地。用户还明确「不在乎 commit 的自洽性」——所以不必为了让每个 commit 自洽而阻塞合并。

**How to apply:**
- **必须合并**：不因主树有并发未提交 WIP 就选「不 FF」。合并是硬要求。
- **退让 = 行级共存**：冲突文件里，我的改动与对方改动若在**不同位置、语义不冲突**（如各自往 status route / config.yaml 不同段加字段），则**两份都保**，不用我的版本覆盖对方。
- **绝不 clobber 对方未提交改动**（git 救不回，`no-destructive-workspace-loss` 红线）。安全机制：`git diff` 备份对方 WIP 到文件 → **选择性** stash 仅重叠文件（`git stash push -- <重叠文件>`，别碰对方 untracked 新模块 + 其他并发脏文件）→ FF（只更新我的文件）→ `git stash pop` 三方合并把对方改动叠回我的新版（不同位则无冲突自动共存）。
- **对方改动不自足时**（如其 status route 3 行依赖对方**untracked 未提交的新模块**）：不能把对方那几行**提交进我的分支**（会吞对方半成品特性 + 拖 untracked 依赖），只能让其作**未提交 WIP 叠回**主树——最终态两者共存、对方 WIP 仍是 WIP、我不吞它特性。
- 实战一次成功：transport-config-reorg 落地时，退让并发 history-v3/tantivy 会话对 `status/route.ts`（+`docs/API.md`/`DESIGN.md`）的未提交改动，备份→选择性 stash 三文件→FF master→pop 干净三方合并，两侧字段共存、对方 untracked `search-tantivy.ts` 留原地。

Related: [[git-commit-pathspec-commits-worktree-not-index]]、CLAUDE.md `concurrent-sessions 行级共存` / `no-destructive-workspace-loss`。

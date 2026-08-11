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

**边界：「两份都保」只适用于两侧都是纯新增；一方改写了 base 已有内容时，并列保留会造成回退。** 上面讲的是**未提交 WIP** 的共存；两边**都已提交**时还有另一种形态，2026-08-08 撞到：`docs/todo/deferred-backlog.md` 这类「各会话往文末追加条目」的文件，第一次冲突两边各加新条目、并列保留正确；**第二次 master 那边把同一条既有条目实施掉并改写成「已关闭」**，而我这边原样保留着它的开放版——此时并列保留会**把别人已完成的实施退回成开放待办**，是实打实的信息回退。

**判别方法（机械可判，别靠读文意）：** 开 `merge.conflictStyle=diff3` 看 base（`|||||||` 段）与两侧的关系——

- 两侧都只在 base 之后**追加** → 并列保留；
- 任一侧**改写了 base 里已有的内容** → 那部分以改写方为准，另一侧只取其**纯新增部分**。

落盘前加一道断言兜底：`ours[:len(base)] == base`（我这侧确实只是追加）。**断言不成立就停下人工核对，不要猜**——它恰好能区分「我只追加了」和「我也改过原文」这两种在肉眼下很像的情况。

Related: [[git-commit-pathspec-commits-worktree-not-index]]、[[methodology-semantic-merge-conflict-exposes-latent-bug-via-timing]]、CLAUDE.md `concurrent-sessions 行级共存` / `no-destructive-workspace-loss`。

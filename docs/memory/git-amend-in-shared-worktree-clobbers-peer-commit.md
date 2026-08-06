---
name: git-amend-in-shared-worktree-clobbers-peer-commit
description: 共享 worktree 里 git commit --amend 是竞态——peer 在你提交与 amend 之间提交会让你静默改写对方的 commit
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f2760de9-33a3-4ce4-8dc8-5c4cc9319da8
  modified: 2026-07-28T12:27:37.195Z
---

**共享 worktree 里绝不用 `git commit --amend`**（改 message 也不行）。`--amend` 作用于「此刻的 HEAD」，而并发 peer 会话可能在你 `git commit` 与 `git commit --amend` 之间提交，把 HEAD 挪走——于是你**静默改写了对方那条 commit 的 message**，还顺手把 index 里 peer 已 `git add` 的文件裹进去。

2026-07-28 实际发生：我提交 `2beaaeae` 后想补 message，peer 在 48 秒内提交了 `1269b962`，我的 `--amend` 把 peer 那条 commit 改成了我的 message（`ce8b7e2c`）。

**Why:** `--amend` 唯一的定位方式是 HEAD 指针，它没有「我是要改我刚才那条」的表达能力；显式 pathspec 保护的是**文件**，保护不了**commit 身份**。

**How to apply:**
- message 写不好就**再提一条**，或者接受它——绝不 amend。
- 真被咬到的补救：`git reflog` 找回 peer 的原 commit hash → `git log -1 --format=%B <hash> > /tmp/peer-msg.txt` → 立刻 `git commit --amend -F /tmp/peer-msg.txt` 还原（tree 相同则内容无损，author date 保留，只有 committer date 差几十秒）。做之前先 `test "$(git rev-parse A^{tree})" = "$(git rev-parse B^{tree})"` 确认 tree 一致，否则你还在丢东西。
- 姊妹坑：`git commit -- <pathspec>` 取工作区、免疫 index race（见 [[git-commit-pathspec-commits-worktree-not-index]]），但**它不保护 amend**。

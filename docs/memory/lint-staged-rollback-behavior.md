---
name: lint-staged-rollback-behavior
description: "bun 的 lint-staged 在 lint 失败时会自动恢复工作区(stash → revert),使得你的 fix 改动只留在后续编辑里——必须重新 git-add 才能真正提交它们"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

在 `/home/xp/src/copilot-api-js` 中,`git commit` 会触发一个 lint-staged hook,它会:

1. **备份**工作区到 `git stash`
2. 对暂存的文件运行 `eslint --cache`
3. 在**失败**时:把工作区回退到 stash,**跳过 commit**,打印错误
4. 在**成功**时:应用任何 autofix 修改,提交

**Practical consequence:** 如果你运行了 `git commit` → 它 lint 失败 → 你接着运行 `bunx eslint --fix` 去修复失败 → 这些修复存在于**工作区**而不在 **index**。重新运行 `git commit` 会从 index 重新暂存(未变化 → 仍是损坏的版本),然后再次 lint 失败。症状:"我刚刚修好了,为什么还在报错?"且错误行号与之前**完全相同**。

**Fix:** 重新 commit 之前先 `git add <fixed-files>`。根据 [[feedback_no_unilateral_action]],这需要用户同意,除非用户已经授权你暂存这些文件。

**Detection:** 如果 `bun run typecheck` 和 `bunx eslint <file>` 都报告干净,但 `git commit` 仍在与之前完全相同的行号上报告 lint 错误,你就处于这个状态——暂存的 blob 已经过时。

用 bun 1.3.14 测试,包 `lint-staged` 经由 husky pre-commit hook 调用。任何其它基于 lint-staged 的配置都有相同行为。

Related: [[feedback_no_unilateral_action]](不能静默地 `git add` 用户文件)。

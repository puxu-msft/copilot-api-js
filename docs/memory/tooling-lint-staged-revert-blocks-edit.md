---
name: tooling-lint-staged-revert-blocks-edit
description: 本项目 pre-commit 已 dc27883 加 --no-stash 消除 lint-staged stash/revert 工作区破坏;通用机制/检测/取证已上行 user-level skill
metadata:
  node_type: memory
  type: project
  originSessionId: f6c2d80a-0cbf-4799-89e9-96768edc3a13
---

**本项目落地态(2026-06-29 dc27883)**:`package.json` 的 `simple-git-hooks.pre-commit` = `bun x lint-staged --no-stash`(原为裸 `bun x lint-staged`)。本项目 lint task 纯校验(`bun run lint`=`eslint --cache`、无 `--fix`),`--no-stash` 消除了对纯校验零收益却破坏工作区的 stash/revert 沙箱,lint 门禁仍在(真错误照样拦 commit)。改 package.json 后须 `bunx simple-git-hooks` 重装 `.git/hooks/pre-commit`。**改回裸 lint-staged 会复现** ghost edit(Edit 报 success 却不落盘)/stale staged blob/peer-collision revert 三模式。

通用机制、检测(Edit success 不自证→`sed` 验证落盘)、`--no-stash` 根治、ghost-edit 取证脚本均已上行 user-level skill **`git-commit-discipline:disarming-lint-staged-rollback`**——本条只留本项目落地态,通用教训不在此复述。相关 [[feedback-pass-null-clean-not-self-validating]]。

---
name: tooling-lint-staged-revert-blocks-edit
description: 本项目已彻底移除 lint-staged/simple-git-hooks pre-commit hook（无 pre-commit 门禁）；通用 rollback 机制/检测/取证见 user-level skill
metadata:
  node_type: memory
  type: project
  originSessionId: f6c2d80a-0cbf-4799-89e9-96768edc3a13
---

**本项目落地态(2026-06-29 起)**:已**彻底移除** lint-staged 与 simple-git-hooks——`package.json` 删去 `lint-staged`/`simple-git-hooks` 配置块与 devDeps、`prepare` 脚本不再调 `simple-git-hooks`、`.git/hooks/pre-commit` 不再安装。**本项目现无任何 pre-commit 门禁**,lint 校验靠手动 `bun run lint`/`lint:all` 与 subagent review,提交不被 hook 拦截或改写工作区。

历史:曾(更早 dc27883)用 `simple-git-hooks.pre-commit = bun x lint-staged --no-stash` 消除 stash/revert 沙箱破坏,后并发会话在一个 grab-bag 'update' 里误删一半(删 deps/config 却留下悬挂 `prepare` 调用 + 空 `simple-git-hooks:{}` 块);本次历史整理按用户最终决策彻底删净并补齐残骸。

通用 lint-staged stash/revert 三失败模式(ghost edit/stale staged blob/peer-collision)、检测(Edit success 不自证→`sed` 验证落盘)、`--no-stash` 根治、取证脚本均在 user-level skill **`git-preference:disarming-lint-staged-rollback`**——若将来重新引入 lint-staged 必读。相关 [[feedback-pass-null-clean-not-self-validating]]。

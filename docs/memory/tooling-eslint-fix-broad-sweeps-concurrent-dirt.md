---
name: tooling-eslint-fix-broad-sweeps-concurrent-dirt
description: 共享 worktree 里对宽文件集跑 eslint --fix 会扫入并发会话留下的既有 lint 违规、夹带大量无关 churn 并与 peer 在飞 import 编辑碰撞
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 095526dd-f4a1-408d-8292-909399df3b4c
---

在共享 worktree（常有并发 agent 会话同改仓库）里,**绝不**对宽文件集跑 `eslint --fix`。

**Why:** 并发会话常把 handler/大文件留在 **lint-dirty 中间态**（单行多-specifier import 违反 `local/multiline-imports`、perfectionist 乱序、prettier 未跑）。你 `--fix` 会把这些**既有违规**一并机械清理（展开+重排 import 块、collapse/expand 对象),导致:① 你的提交夹带大量与语义改动无关的 churn（实测:8 文件本该 30 行,--fix 后变 167 行,单 handler +59）;② 重排他人正在改的 import 块 = 与 peer 在飞工作**行级碰撞**。这是 [[sed-touched-files-bundle-inflight-work]] 的 eslint 版。

**How to apply:**
- 宽文件集**只 lint-check 不 --fix**（`bunx eslint <files>` 无 `--fix`）。`--fix` 只用于**你自己新建**的文件。
- 你**手加的 import 行**自己按 perfectionist 顺序放对位（如 `models/endpoint` < `models/resolver` < `models/timeout-resolver`）,别靠 --fix 排。既有 dirt 不是你的、别顺手修（会夹带+碰撞）。
- 判据:改动文件在 **master(HEAD) 上本就 fail lint** = 并发/既有 dirt,留着;只有你**新引入**的违规才修。
- **恢复**(已 --fix 污染后):先 `git diff` 过滤出「非 import-reorder、非我语义行」确认**零他人语义改动**(`git diff -- f | grep '^[+-]' | grep -vE '<我的关键词|import>'`);确认干净后,单文件 `git show HEAD:f > f` 恢复 master(**只动这一个文件、非 `git checkout -- <多文件>` 那种会 sweep 他人未提交工作的操作**)→ 重贴你的最小语义编辑。小 churn 文件（只你的编辑 + 个别 prettier）逐块 Edit 收回即可。
- 提交一律**显式 pathspec 只提交你的文件**;并发 peer 若把 state/config/schema 改成 typecheck 破损的在飞态,那是他们的、`commit-is-error-tolerant`,别代修、别把他们的 M 文件纳入你的 pathspec。

实例(2026-07-12 per-model idle-timeout Phase 2):对 8 个 handler 跑 --fix,扫入并发 system-prompt-scoping 会话留在 chat/responses handler 的既有 import dirt,churn 从 30 炸到 167;恢复=核实无他人语义改动 → `git show HEAD:f>f` 恢复 chat/responses → 重贴 2 行 → 显式 pathspec 提交,peer 的 state/config/schema WIP 原样留工作区。

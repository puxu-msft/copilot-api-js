---
name: methodology-dont-merge-into-midflight-multicommit-refactor
description: 合并 peer 正在滚动的多提交重构会合进中间态、textually-clean 但语义崩；等其落定或退到 last-green，别追 tip
metadata: 
  node_type: memory
  type: project
  originSessionId: 37ff3628-3043-43ba-8953-2bd2f8090cac
  modified: 2026-07-23T08:01:25.148Z
---

并发 worktree 场景下把 master 合进自己分支时，若 master 正处于一个**跨多提交的重构中途**（rename 在 commit N、usages 在 commit N+1、类型定义在 commit N+2），合进**中间态**会得到「textually 无冲突、但类型/语义崩」的结果——git 只按行合并、不知道跨提交的语义契约。

**实例（Phase 0 合并 master）**：master 的 `resolveCodecModel` 重构分三提交落（`229dec62` 加 primitive → `f926427a` 迁 4 codec → `251babf9` rename `clientModel`→`resolvedModel`）。合到 `229dec62`/`f926427a` 中间点时，`codec.ts` 用了 `.resolvedModel` 但 `FallbackExchange` 类型还是 `clientModel`（rename 尚未落）→ `TS2339 Property 'resolvedModel' does not exist`，无任何 conflict marker。合到 `251babf9`（重构落定）后同一合并干净通过。

**How to apply:**
- 合并前 `git log --oneline <base>..master -- <热点目录>` 看 peer 是否在这些路径上有一串**未完成的重构提交**；有就**等它落定**（最后一个 refactor commit 之后）再合，或只合到某个**自洽的 commit 边界**（如一个 Merge commit）。
- 合进后 typecheck 若报「textually-clean 但类型不一致」的错，别急着手工缝——先判断是不是合进了 peer 重构中途；是就退到 last-green（`git reset --hard <last-green>`，本分支可 reflog 恢复）等落定重合，别陷入追一个还在滚动的 tip。
- 追 tip 是徒劳：master 高频提交时，你解完中间态冲突它又推进了。**退到 last-green 等窗口**比逐个中间态缝更省。

**Related:** [[methodology-semantic-merge-conflict-exposes-latent-bug-via-timing]]（那条是运行时时序型语义崩、本条是跨提交重构中间态型）、[[feedback-merger-yields-but-merge-must-happen]]（谁合并谁退让但必须合）、[[git-commit-pathspec-commits-worktree-not-index]]。FF 前实测：peer WIP 文件 ∩ FF 改动文件 = ∅ 时 `git merge --ff-only` 对脏主树安全（git 只碰它改的文件、有重叠则中止），且不重启运行中的 server（Linux open-file 替换）。

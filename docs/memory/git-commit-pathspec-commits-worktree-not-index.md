---
name: git-commit-pathspec-commits-worktree-not-index
description: git commit -- <pathspec> 提交工作区版本而非 index，会绕过 git apply --cached 的 hunk 过滤、把 peer 的在飞改动整文件扫进 commit
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ff80287a-056d-4a76-9ea8-72d93bd0c86e
---

`git commit -F msg -- <pathspec>`（带 pathspec 的 commit）**提交命名路径的工作区当前内容、无视 index** —— 等价于先 `git add <那些路径>` 再提交。所以它会**绕过我用 `git apply --cached` 精心过滤进 index 的 hunk**，把同一文件里 peer 的在飞改动（如另一会话对 config.yaml 的 relocation）整文件扫进我的 commit。

**Why**：在 shared worktree 用 `git apply --cached /tmp/attr.patch` 只把自己那几行加进 index（config.yaml staged diff 实测仅 4 行、relocation grep=0，正确），却随后用 `git commit -F msg -- config.yaml ...` 提交 —— pathspec 形式取**工作区** config.yaml（含 relocation+我的新增 34 行变更），把 peer 的 relocation 扫进了我的 commit。staged diff 干净 ≠ pathspec commit 干净，二者数据源不同。

**How to apply**：
- 想提交**精确暂存的 index 内容**（尤其用了 `git apply --cached` / `git add -p` 做 hunk 级过滤后）→ 用 **`git commit -F msg`（无 pathspec）**，它提交整个 index、忠实反映我过滤后的暂存态。提交前 `git diff --cached --stat` + 内容 grep 核验 index 即可。
- pathspec 形式 `git commit -- <paths>` 只在「想提交这些文件的**完整工作区**版本、且确信它们无 peer 混入」时才安全（即 `concurrent-sessions-line-coexistence` 里说的「无视 index 里别人塞入的**其他文件**」用法）——但它对**同一文件内的 hunk 级过滤无效**，会取整个工作区文件。两种需求别混：排除别的文件用 pathspec commit；排除同文件内 peer 的 hunk 用 `apply --cached` + **无 pathspec** commit。
- 误提交后的恢复（commit 是本地未 push、且确认 HEAD 就是我的 commit 无 peer 叠加）：`git reset --soft HEAD^`（只移分支指针、不碰工作区、不丢 peer 在飞工作）→ `git restore --staged <被污染文件>` → 重 `git apply --cached` 我的 patch → `git commit -F msg`（无 pathspec）。reset --soft 在此安全（非 reset --hard），但前提是先 `git log` 确认无 peer commit 叠在我的之上。

扩展 [[sed-touched-files-bundle-inflight-work]]（那条讲 `git add <file>` 扫入在飞工作，本条讲 `git commit -- <file>` 同样扫入且更隐蔽——因为它跳过 index 这层我以为已过滤的防线）与 user-level skill `git-commit-discipline:avoiding-shared-worktree-conflicts`（其 Quick reference 已列 `-F`/`-m` 须在 `--` 前，但未强调 pathspec 取工作区而非 index 这层）。

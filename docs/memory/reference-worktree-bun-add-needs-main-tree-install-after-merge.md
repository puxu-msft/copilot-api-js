---
name: reference-worktree-bun-add-needs-main-tree-install-after-merge
description: worktree 里 bun add 装的依赖只进该 worktree 的 node_modules；FF 合并回主树后主树 node_modules 陈旧、Vite/构建解析不了新包，须在主树补跑 bun install
metadata: 
  node_type: memory
  type: reference
  originSessionId: bcb244cc-4f65-450e-8ba1-4ff76efe80f2
---

隔离 worktree + subagent-driven 流程里，若某 Task `bun add <pkg>`（如列配置 Task 3 加 `@dnd-kit/core/sortable/modifiers`），依赖只装进**那个 worktree 自己的 node_modules**（每个 worktree 独立 node_modules，gitignore）。`package.json` + `bun.lock` 的改动会随 FF 合并回 master，但**主 worktree 的 node_modules 不会自动同步**——删除子 worktree 后，主树 node_modules 里根本没有新包。

**症状**：用户在主树起 ui-v4 dev server 做视觉核验 → Vite「Failed to run dependency scan / dependencies imported but could not be resolved」（找不到 `@dnd-kit/*`）；或 typecheck `Cannot find module`。

**How to apply:**
- **worktree SDD 收尾清单加一条**：若分支动过 `package.json` deps（`git diff master -- '**/package.json'` 非空），FF 合并后在**主树**补跑 `bun install` 同步 node_modules，再交用户起服核验。
- `bun install` 是非服务器命令、no-auto-server 允许；它按合并后的 `bun.lock` 装齐（本例装 5 包：三 @dnd-kit + 传递 utilities/accessibility）。
- 验证解析用 `bun run typecheck:ui-v4`（无 `Cannot find module`）或 `build:ui-v4`，别只看 `ls node_modules`。
- 通用：任何「合并了加依赖的分支」后，消费该依赖的树都要 install；worktree 隔离放大了这点（子树装了、主树没装）。

**Related:** worktree SDD 流程见 [[git-commit-pathspec-commits-worktree-not-index]]；no-auto-server 见 CLAUDE.md 工程纪律。实例来自 2026-07-11 列配置特性（dnd-kit reorder）合并后。

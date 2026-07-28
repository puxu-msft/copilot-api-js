---
name: reference-worktree-bun-add-needs-main-tree-install-after-merge
description: worktree 不继承 gitignored 产物，两个方向都会咬：① worktree 里 bun add 的依赖不进主树，FF 后主树须补 install；② 新建 worktree 里缺 native/*.node 等构建产物，在其中跑测试会红成一片、极易误判为既有失败
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

## 反方向（2026-07-28 新增）：新建 worktree **缺** gitignored 构建产物，测试红了不等于真失败

同一根因（worktree 只拿 git 追踪的东西）的另一个方向。`native/history-search/*.node` 被 `.gitignore:13` 排除，所以**任何新建 worktree 里都没有它**——在该 worktree 跑 `bun scripts/parallel-test.ts unit it http` 会稳定红 14 条 history-search（报 `[history-search] native Tantivy module unavailable`），而同一提交在主树跑是全绿。

**How to apply:**
- 在 worktree 里拿到一批失败时，**先问「主树跑同一提交是不是也红」**，别急着归因。我 2026-07-28 就把这 14 条错误归成「rustup 无默认 toolchain」——toolchain 问题是真的（它挡住 `build:history-search`），但**那不是这 14 条红的原因**，原因是所在的 worktree 压根没有那个产物。归因错了会让「与我的改动无关」这个结论建立在错误前提上（结论碰巧对，推理是错的）。
- 判据一条命令：`git check-ignore -v <失败模块依赖的产物路径>`——命中即说明 worktree 不会有它。
- 交付前的全量回归**在主树跑**（或先把产物拷进 worktree），worktree 内的红当环境噪声先隔离。

**Related:** worktree SDD 流程见 [[git-commit-pathspec-commits-worktree-not-index]]；no-auto-server 见 CLAUDE.md 工程纪律。实例来自 2026-07-11 列配置特性（dnd-kit reorder）合并后。

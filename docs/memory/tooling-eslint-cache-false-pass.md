---
name: tooling-eslint-cache-false-pass
description: 本地工具/环境状态让门禁「说谎」的一族——eslint --cache 对缓存过期文件假绿（核验须无缓存 bunx eslint <path>）；姊妹：合并改依赖后目标 worktree 的 node_modules 陈旧 → typecheck 报 TS2307 + 一串 implicit-any 假象（一个根因 = 缺 bun install，非多处真错）
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dc988ea6-b212-44a4-8a4e-994f79bd2661
---

本仓 lint 脚本历史上是 `eslint --cache`（`package.json` 的 `lint`/`lint:all`）。eslint 的文件级缓存会**跳过自上次成功 lint 后未变更的文件**——如果某文件在缓存变暖之后、规则/类型推断发生变化，或该文件在缓存里被记成 clean，后续 `eslint --cache .` 会**对它假绿**，即使它现在真的有 error。

**根治（2026-07-07）**：`lint:all` 已去掉 `--cache`（`"lint:all": "eslint ."`），使全量扫描始终新鲜、名副其实；`lint`（带 pathspec 的 dev 内环）保留 `--cache` 换速度。当次去缓存后 `eslint .` 暴露并清掉了 44 条被掩盖的存量债（43 格式化 + 1 `scripts/migrate-legacy-entries.ts` 的 `no-floating-promises` 真 bug：async `insertCompletedEntry` 未 await）。

**实证（原始触发）**：ui-v4 Models 页 P2 提交时声称「lint 0 error」，但 P3 会话用 `bunx eslint ui-v4/src`（无缓存）一跑，发现 P2 已提交文件里有 5 个真 error（2× no-nested-ternary、1× no-non-null-assertion、2× no-unnecessary-condition on `??`）——全被 `--cache` 掩盖。

**Why**：会话末尾自证「lint 干净」若跑的是带缓存路径，属于自证性结论（→ [[feedback-pass-null-clean-not-self-validating]]），不可信。

**How to apply**：全量核验现可信 `bun run lint:all`（已无缓存）。但 targeted 核验（`bun run lint <path>` 仍带 `--cache`）不可信——核验单个文件是否真干净须跑**无缓存**的 `bunx eslint <精确路径>`。注意 `.tsx` 测试文件不在 `eslint.config.js` 的 test-relaxation glob（只匹配 `**/*.test.ts`/`tests/**/*.ts`），故 `.tsx` 测试受生产级严格规则约束。ui-v4 现有 react-hooks/jsx-a11y 规则（glob 限 `ui-v4/**`）。

## 姊妹：合并/切换改依赖后，目标 worktree 的 node_modules 陈旧 → typecheck 假象（2026-07-08 requests-list 合并收尾实证）

同一族「本地状态让工具说谎」的另一面：一个引入了新运行时依赖的分支（如 requests-list 加 `react-virtuoso` / `react-day-picker`）合并进 master 后，**被合并进的主 worktree 的 `node_modules` 仍是旧的**（merge 只更新了 `bun.lock`，没同步 `node_modules`）。此时 `bun run typecheck` 会报 `TS2307: Cannot find module 'react-virtuoso'`，并**级联出一大堆 `TS7006/TS7031 implicit any`**（该库的组件类型解析不出 → 消费它的每个 props/参数都成 any）——看起来像十几处不相关的类型错误，**根因只有一个：缺 `bun install`**。

**实证**：requests-list 分支在其隔离 worktree（已 `bun install`）里 typecheck 全绿；`--no-ff` 合并进 master 后，主 worktree typecheck 突然报 react-virtuoso 找不到 + PoC 测试一串 implicit-any。在主 worktree 跑 `bun install`（同步 4 个新包）+ 清 `tsbuildinfo` 后重跑 → 干净。**别去逐个「修」那些 implicit-any**（它们是症状不是病）——先 `bun install` 让依赖到位，绝大多数「错误」自动消失。

**Why**：`git merge` / `git worktree add` 都不跑 `bun install`；跨 worktree 或合并改依赖后，本地 `node_modules` 与 `bun.lock` 会漂移，typecheck/build 反映的是**陈旧环境**而非提交真相（→ 与上面的 `--cache` 假绿同源：工具结论受本地陈旧状态污染，不是代码真相）。相关：新加的 worktree 本就无 `node_modules`（见 user skill `git-preference:isolating-from-a-shared-worktree`）。

**How to apply**：① 合并了改 `package.json`/`bun.lock` 的分支后，在目标 worktree 先 `bun install` 再判 typecheck/build；② 见到 `TS2307 Cannot find module '<新依赖>'` + 成片 implicit-any，先怀疑缺 install、别逐个加类型标注；③ 跨 worktree typecheck 结果不一致（一处绿一处红、同一提交）时，先对齐 `node_modules`（`bun install`）+ 清 `tsbuildinfo`（`find <pkg> -name '*.tsbuildinfo' -delete`）再复判——`tsc --incremental` 的缓存也可能让不同 worktree 的错误集看起来不一致（次要因素，本次未单独证实，但对齐环境后即消解）。

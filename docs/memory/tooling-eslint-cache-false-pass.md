---
name: tooling-eslint-cache-false-pass
description: lint gate 的 --cache 会对「已提交但缓存过期」文件假绿；2026-07-07 起 lint:all 已去 --cache（全量权威），但 lint（targeted）仍带缓存——核验 targeted 干净须无缓存 bunx eslint <path>
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

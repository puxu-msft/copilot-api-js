---
name: tooling-eslint-cache-false-pass
description: 本仓 lint gate 用 eslint --cache，可对「已提交但缓存过期」的文件假绿；核验 lint 干净须跑无缓存 bunx eslint <path>
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dc988ea6-b212-44a4-8a4e-994f79bd2661
---

本仓 lint 脚本是 `eslint --cache`（`package.json` 的 `lint`/`lint:all`）。eslint 的文件级缓存会**跳过自上次成功 lint 后未变更的文件**——如果某文件在缓存变暖之后、规则/类型推断发生变化，或该文件在缓存里被记成 clean，后续 `eslint --cache .` 会**对它假绿**，即使它现在真的有 error。

**实证**：ui-v4 Models 页 P2 提交时声称「lint 0 error」，但 P3 会话用 `bunx eslint ui-v4/src`（无缓存）一跑，发现 P2 已提交文件里有 5 个真 error（2× no-nested-ternary、1× no-non-null-assertion、2× no-unnecessary-condition on `??`）——全被 `--cache` 掩盖。

**Why**：会话末尾自证「lint 干净」若跑的是带缓存路径，属于自证性结论（→ [[feedback-pass-null-clean-not-self-validating]]），不可信。

**How to apply**：核验 lint 是否真干净，跑 **无缓存**的 `bunx eslint <精确路径>`（对着要提交的文件），而不是依赖 `bun run lint`/`lint:all` 的缓存结果。收尾门禁按此执行。注意 `.tsx` 测试文件不在 `eslint.config.js:113` 的 test-relaxation glob（只匹配 `**/*.test.ts`/`tests/**/*.ts`），故 `.tsx` 测试受生产级严格规则约束。

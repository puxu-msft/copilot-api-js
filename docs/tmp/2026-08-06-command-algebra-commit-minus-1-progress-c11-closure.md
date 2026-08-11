---
slug: commit-minus-1-c11-closure
base: 39fd3a31f03612456d6e9dee7661f34d8746bce9
branch: agent-a7cfa0f0dec4c9817
worktree: /home/xp/src/copilot-api-js/.worktree/agent-a7cfa0f0dec4c9817
plan: docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-minus-1.md
status: 实现完成，待最终验证、文档同步与独立复评
---

# 进度 —— Commit -1 C11 dependency closure

## 剩余项

1. 恢复历史 worktree 的未提交 ancestor-resolution 测试与实现 WIP；验收：文件级 diff 仅含已识别的 validator/test 两文件改动。
2. 先运行 ancestor-resolution 正样本，确认 `39fd3a31` 实现因 TREE-local 假设转红；再完成 content-identity green 实现。
3. 让 generator 与 validator 共用递归 runtime import discovery，而非手写 saxes/xmlchars 文件清单；验收：ancestor/cache/symlink-like 正样本绿，dirty bytes、wrong version、missing/altered manifest、unexpected bare import 均在 receipt 前以 C11 红，generator 重跑 deterministic。
4. 运行 parser、producer、validator、typecheck、Prettier、diff-check 与 backend，更新 durable integration report，并将代码/tests/manifest/generator与文档分开提交。

## 在途意图

- 依赖身份绑定到 Bun 实际解析结果的 `package name + version + package-relative recursive runtime closure hashes`，并由 ENTRY 中 `package.json`、`bun.lock`、integrity manifest 约束；物理位置可在 TREE、祖先、cache 或 symlink realpath。
- local graph cycle 语义是“终止且每节点验证一次”，不是拒绝 cycle。

## 已作废的路子

- 强制 `$TREE/node_modules/{saxes,xmlchars}`：正确的新 worktree 会向祖先依赖解析，造成 C11 false-red。
- generator 与测试共享手写四文件清单：同源 oracle 无法证明 runtime closure 完备性。

## 当前证据

- `39fd3a31` 上 ancestor-resolution 正样本得到 rc=7/C11，复现 false-red；恢复内容身份实现后 validator 40 pass。
- `Bun.build(..., metafile:true)` 从实际 `saxes` entry 递归枚举 saxes+xmlchars runtime graph，generator 与 validator 共用该 primitive。
- exact mutation 从发现集合丢弃新增 `unexpected.js` 后，目标测试由绿转红（期望 rc=7，实际 rc=0）；恢复后 40 pass。
- whole-branch 复评暴露 helper 自证 bootstrap 与 observed/manifest package 单向比较；新增 sentinel 证明 dirty helper 在修复前已执行，新增第三 package 证明旧 validator 错误放行。
- validator 现先以仅 built-ins 的 fixed-path + ENTRY blob bootstrap 验 helper，再 dynamic import；observed 与 manifest package names 先做 bytewise 精确相等，再逐包核内容。
- parser+producer+validator focused 合计 63 pass；`bun run typecheck` 绿。

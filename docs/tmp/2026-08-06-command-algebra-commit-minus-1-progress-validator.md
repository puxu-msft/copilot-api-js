---
slug: commit-minus-1-validator
base: 5b305ed3
branch: command-algebra-commit-minus-1
worktree: /home/xp/src/copilot-api-js/.worktree/command-algebra-commit-minus-1
plan: docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-minus-1.md
agent_id: （派发后回填）
session_id: 046d7295-e5ce-470b-a284-c721c6ce1cb8
---

# 进度 —— Commit -1 T0.0e evidence validator

> T0.0e 是与 runner/producer checkpoint 分开的独立 task，可派新的 implementer。原 implementer transcript 已被平台销毁；T0.0a/b/c 已 task-review 通过并集成。
> 每个语义 commit 同步提交本文件。只记剩余项、在途意图、作废路径。

## 剩余项

- [ ] 实现/version `scripts/validate-entry-evidence.ts`，严格按 plan §0.4f CLI/pointer/manifest/receipt v1/exit contract
- [ ] 合成 git 图/A/P/pointer/manifest/15 logs/JUnit fixtures 正样本
- [ ] EV-01～EV-28：每个单一 action→唯一 FAIL Cn，mutation hard rule
- [ ] receipt atomic write；C1～C11 全过才写；失败无旧/半份 receipt
- [ ] covering tests、typecheck、test:backend、task review

## 在途意图

- validator 必须从原始 artifacts 独立重算，不信 manifest 内部自洽。
- discovery baseline path/hash/runner blob 由 C11 从 ENTRY_SHA git object 读取。
- T0.0e 只用合成 evidence，不读取未来真实 A/P。

## 已作废路径

- 不用 current master HEAD 猜 P；POINTER_SHA 显式输入。
- 不在 post-merge T0.0d 才实现 validator。
- 不把多个 failure mechanisms 合成一个 mutation。

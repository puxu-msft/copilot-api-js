---
slug: commit-minus-1-validator
base: 3a224ea130c3b8eaeab7f5d41c6e24044619a9dd
branch: agent-a52b75c6a491a4fd9
worktree: /home/xp/src/copilot-api-js/.worktree/agent-a52b75c6a491a4fd9
plan: docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-minus-1.md
agent_id: （派发后回填）
session_id: 046d7295-e5ce-470b-a284-c721c6ce1cb8
---

# 进度 —— Commit -1 T0.0e evidence validator

> T0.0e 是与 runner/producer checkpoint 分开的独立 task，可派新的 implementer。原 implementer transcript 已被平台销毁；T0.0a/b/c 已 task-review 通过并集成。
> 每个语义 commit 同步提交本文件。只记剩余项、在途意图、作废路径。

## 剩余项

- [ ] 完成 Commit -1 全部 runner/producer gate 的整合验证、独立 task review，以及 `bun run test:backend`；本文件只覆盖 T0.0e validator。
- [ ] post-merge T0.0f/T0.0d 在真实 A/P 上消费本 validator；本 task 不生成或消费真实 evidence。

## 当前在途

- T0.0e 已完成：C1～C11 从 pointer、manifest、raw logs/JUnit/artifacts 和 ENTRY_SHA objects 独立验证；EV-01～EV-28 全部具名 mutation、正样本 receipt v1 与 receipt collision rc=8 均覆盖。
- validator 成功仅在 C1～C11 全绿后调用 `writeReceiptAtomically`；receipt 严格 v1 字段与 stdout path/hash 已由合成 fixture 断言。
- C1～C6 checkpoint 的深层路径/alias 防护保留；C7～C11 使用 `/tmp` 合成 A/P/15 logs/JUnit/baseline，未消费 future real A/P。

## 在途意图

- validator 必须从原始 artifacts 独立重算，不信 manifest 内部自洽。
- discovery baseline path/hash/runner blob 由 C11 从 ENTRY_SHA git object 读取。
- T0.0e 只用合成 evidence，不读取未来真实 A/P。

## 已作废路径

- 不用 current master HEAD 猜 P；POINTER_SHA 显式输入。
- 不在 post-merge T0.0d 才实现 validator。
- 不把多个 failure mechanisms 合成一个 mutation。

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

- [ ] 完成 C7～C11 的原始 artifact 独立重算及 EV-16～EV-28；C1～C6 checkpoint 已实现但尚未独立审查。
- [ ] 补 EV-01、EV-14、EV-15 的单输入 mutation test；C6 的 duplicate-log-path guard 已覆盖额外 reviewer finding，但原 plan 的三条 mutation 仍需独立断言。
- [ ] 让 validator 仅在 C1～C11 全绿后调用 receipt writer，并覆盖 strict receipt schema；writer 已改为 invocation-unique `O_EXCL` temporary + no-replace `linkSync` publish，当前仍无调用方且刻意不会生成 checkpoint receipt。
- [ ] 完成 prettier、`bun run test:backend`、独立 task review；不得将当前局部 `typecheck`／focused test 作为完成验收。

## 当前在途

- C1～C6 checkpoint 已补深层路径与 artifact 防护：非存在的 tree receipt destination、symlink parent、manifest schema version、以及 realpath alias log 均有合成测试；receipt 的完整 body 由 `writeFileSync(fd, body)` 写入后才可 no-replace publish。
- 未消费真实 future A/P；所有现有 fixture 均在 `/tmp` 临时 git 仓库构造。

## 在途意图

- validator 必须从原始 artifacts 独立重算，不信 manifest 内部自洽。
- discovery baseline path/hash/runner blob 由 C11 从 ENTRY_SHA git object 读取。
- T0.0e 只用合成 evidence，不读取未来真实 A/P。

## 已作废路径

- 不用 current master HEAD 猜 P；POINTER_SHA 显式输入。
- 不在 post-merge T0.0d 才实现 validator。
- 不把多个 failure mechanisms 合成一个 mutation。

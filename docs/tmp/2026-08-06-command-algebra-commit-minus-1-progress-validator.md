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
- reviewer finding ① C7/C8 unreadable artifact 边界已处置：每 run 严格验证完整 artifact schema、canonical artifact_dir/log 绑定、目录 JUnit 枚举、containment、basename order 与 raw SHA；JUnit/runtime identity 的 directory/hash/read/parse 失败稳定 rc=6/C7，skipped multiset 对应失败稳定 rc=6/C8，均不会泄漏 rc=1。C10 aggregate artifact 的 directory/hash/read 失败稳定 rc=7/C10。已覆盖三种 per-run directory shape、malformed JUnit 与三种 top-level directory shape。
- reviewer finding ② C7/C8 artifact trust 已补强：缺失 artifact_dir、JUnit、runtime identity 一律 rc=6/C7；缺失 skipped multiset 一律 rc=6/C8，均不泄漏为 rc=1。runtime/skipped JSON fail-closed，testcase/suite discriminated multiset 使用严格 discriminated identity schema 与 UTF-8 bytewise key 比较；非 ASCII reorder false-red 正控、multiplicity 负控、六类 malformed union arm 负控已绿。
- reviewer finding ③ C9 已处置：manifest top-level intents、per-run verdict、raw log、ENTRY_SHA/frozen command 三方逐 run 对账，错误类型和 artifact_dir 分歧均稳定 fail C9。
- reviewer finding ④ C11 已处置：baseline 以 binary-safe git object 原始 bytes、fatal UTF-8 和 canonical parse 验证；执行 validator 与其三个 runtime helper（receipt/schema/JUnit parser）各自 canonical path/blob 必等于 ENTRY_SHA object。静态 runtime relative-import 集合必须精确等于 bound dependency set，因而新增 runtime import、缺失 ENTRY dependency object、任何 helper workspace bytes 篡改均在 receipt 前稳定 fail C11。fixture 覆盖 baseline final-newline、执行 validator 与每个 helper source 篡改、以及 import-closure drift。
- reviewer finding ⑤ 已处置：EV runtime registry 从 frozen plan 解析 28 行、每次 `expectEv` 成功后登记；unfiltered 32-pass run 的 afterAll 输出 28-ID reconciliation 四行，含 literal A2/P2 graph EV-27。
- integration regression 已处置：backend 并行竞争下，原单一 “EV-02 through EV-13” 测试在 5s timeout 内累计构造 12 个临时 git graph，实测 7061ms。已按 pointer field、graph、execution/log 独立语义拆为七个 tests；每个 `expectEv` 仍恰好登记一次，afterAll reconciliation 不变。`bun run test:backend` 已绿。
- validator 成功仅在 C1～C11 全绿后调用 `writeReceiptAtomically`；receipt 严格 v1 字段与 stdout path/hash 已由合成 fixture 断言。artifact_dir 的 raw log/manifest 字符串相等先于 canonical containment；同一绝对 symlink spelling 指向 TREE 外真实 artifact 目录的正样本已生成 green receipt。C1～C11 仅用 `/tmp` synthetic A/P/15 logs/JUnit/baseline，未消费 future real A/P。

## 在途意图

- validator 必须从原始 artifacts 独立重算，不信 manifest 内部自洽。
- discovery baseline path/hash/runner blob 由 C11 从 ENTRY_SHA git object 读取。
- T0.0e 只用合成 evidence，不读取未来真实 A/P。

## 已作废路径

- 不用 current master HEAD 猜 P；POINTER_SHA 显式输入。
- 不在 post-merge T0.0d 才实现 validator。
- 不把多个 failure mechanisms 合成一个 mutation。

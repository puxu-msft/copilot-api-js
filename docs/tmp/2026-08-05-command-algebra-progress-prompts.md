---
slug: prompts
base: effa740a
branch: master
worktree: /home/xp/src/copilot-api-js
plan: docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md
agent_id: afd4f3231ff3d93a0
session_id: 046d7295-e5ce-470b-a284-c721c6ce1cb8
---

# 进度 —— command algebra 第三层 prompts

> **状态：已完成，并由正式产物取代。停止更新本文件。** 权威状态在 `docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md`；执行入口在 `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md`；第二层计划在同目录 `cutover-plan.md`。
> 本文件由派活方按 skill `session-closeout` §6b 在派活前建立，现仅保留中断恢复与评审整改历史。Task 数从 plan 集合派生，最终快照为 **84/84**，不是 SSOT。

## 剩余项

- [x] **独立评审完成**：判据证伪与执行方走查各 8 轮；最终分别为 0 blocker / 0 major，以及 0 blocker / 0 major / 0 minor / 0 nit。完整报告：`docs/tmp/2026-08-05-command-algebra-prompts-review-{criteria,executor}.md`。
- [x] `prompts/README.md`：导航、阶段依赖 DAG、可并行边界、共享文件／合并顺序、通用红线
- [x] Commit -1 self-contained prompt（T0.0a/b/c/e；独立 worktree；mutation hard rule；合 master）
- [x] post-merge entry-evidence preflight prompt（A／15 runs／manifest／P／T0.0d）
- [x] Commit 0～8 共 9 份 self-contained prompt
- [x] 每份 prompt 引用正确的 design／plan／traceability／progress 路径，含目标、锚点、TDD、门、提交指引、红线指针
- [x] prompt task 人口与 `cutover-plan.md` 双向对账：checker 从 plan 的 live task tables 解析集合并校验 phase owner；最终输出 **84/84**、无 duplicate/orphan/unassigned/wrong-phase
- [x] `traceability-check.py` rc=0，prompt 专用 task-population checker rc=0（checker 位于 `exp/inter-block-anchor-allocator/prompt-task-check.py`；支持 `PLAN=`/`PROMPTS=` 副本正控）

## 完成前核验

- prompt checker 正样本原样输出：`plan tasks: 84`、`prompt tasks: 84`、`duplicates: none`、`orphans: none`、`unassigned: none`、`wrong-phase: none`、`prompt-task-check: OK`。
- mutation controls：suffix、删除定义留历史 mention、同/跨 Commit 搬整行、同 Commit 历史 task 表会分别报 orphan/unassigned/wrong-phase；副本在 `/tmp`，真实 prompts 未被改。
- 全部 12 prompt（README + -1 + preflight + C0…C8）完整通读并经过 8 轮双视角复评；所有 prompt residue scan 0、`git diff --check` 0。
- **未验证**：prompt 只是派发件，未实际执行任何 phase；其中的 `file:line`/当前状态锚在已放行 plan，执行前仍须按各 prompt 的「引用 plan 锚点表」重取。O-6 真请求近期 HTTP 500，prompts 不声称其完整 PASS，仅引用已验证的结构化 evidence 路径。

## 本轮进度

- 全部 prompts、checker、评审报告与状态同步均已提交；正式状态见 HANDOVER／prompts README。
- 陈旧「82／83」均已撤除：集合是 SSOT，最终派生快照 84；不得为凑数字排除 post-merge task。

## 在途意图

- 第三层只翻译、分派第二层已经冻结的 plan；**不得新增签名、不得重裁待裁项、不得把 plan 的已知边界升级成机械闭合**。
- Commit -1 与 post-merge preflight 是不同相位：前者交付 runner oracle + validator；后者消费真实 A／P／15 artifacts。禁止重新混回一份 prompt。

## 已作废的路子

- 不把全套 plan 复制进每份 prompt：契约与判据细节仍以 design／cutover-plan／traceability 为单一事实源，prompt 只需 self-contained 到“独立执行者能按引用开工”，不是复制 80KB 文档。

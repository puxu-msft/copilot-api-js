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

> 派活前建立，按 skill `session-closeout` §6b。预计多文件、多 commit、需把 `cutover-plan.md` 的**实际 task 集合**分派到 Commit -1／post-merge preflight／Commit 0～8，属于必须建进度文件的形状。**不写死数量**：prompt population checker 从 plan 解析集合；当前运行输出 83，仅作快照，不是 SSOT。陈旧「82」与冻结集合冲突时，正确处置是信集合，不为凑数删/排 task。
> **只记 git 记不下来的三样**：剩余项（带验收判据）／在途意图／已作废的路子。每个语义 commit 一起更新并提交。

## 剩余项

- [x] `prompts/README.md`：导航、阶段依赖 DAG、可并行边界、共享文件／合并顺序、通用红线
- [x] Commit -1 self-contained prompt（T0.0a/b/c/e；独立 worktree；mutation hard rule；合 master）
- [x] post-merge entry-evidence preflight prompt（A／15 runs／manifest／P／T0.0d）
- [x] Commit 0～8 共 9 份 self-contained prompt
- [x] 每份 prompt 引用正确的 design／plan／traceability／progress 路径，含目标、锚点、TDD、门、提交指引、红线指针
- [x] prompt task 人口与 `cutover-plan.md` 双向对账：**不写死数量；checker 从 plan 解析实际集合（当前输出 83）**，每 task 恰归一个执行 prompt
- [x] `traceability-check.py` rc=0，prompt 专用 task-population checker rc=0（checker 位于 `exp/inter-block-anchor-allocator/prompt-task-check.py`；支持 `PLAN=`/`PROMPTS=` 副本正控）

## 完成前核验

- prompt checker 正样本原样输出：`plan tasks: 83`、`prompt tasks: 83`、`duplicates: none`、`orphans: none`、`unassigned: none`、`prompt-task-check: OK`。
- suffix mutation：`T4.0d→T4.0z` 明确报 orphan `T4.0z` + unassigned `T4.0d`；删除 `T0.0e` 明确报 unassigned `T0.0e`。两条都在 `/tmp` 副本运行，真实 prompts 未被改。
- 全部 12 prompt（README + -1 + preflight + C0…C8）完整通读；修正 README 标题为固定骨架的 `## 红线（集中）`。所有 prompt residue scan 0、`git diff --check` 0。
- **未验证**：prompt 只是派发件，未实际执行任何 phase；其中的 `file:line`/当前状态锚在已放行 plan，执行前仍须按各 prompt 的「引用 plan 锚点表」重取。O-6 真请求近期 HTTP 500，prompts 不声称其完整 PASS，仅引用已验证的结构化 evidence 路径。

## 本轮进度

- 第一批已落盘：`README.md`、`commit-minus-1.md`、`post-merge-preflight.md`、`commit-0.md`。入口图/因果分相位是第三层最容易漂的部分，先单独提交。
- Commit 1～8 prompts 已写入工作树，待实际集合对账与全量通读后提交。
- 陈旧「82」已按协调者裁定撤除：plan 实际解析 83，集合才是 SSOT。不得为凑旧数字排除 post-merge `T0.0d`。

## 在途意图

- 第三层只翻译、分派第二层已经冻结的 plan；**不得新增签名、不得重裁待裁项、不得把 plan 的已知边界升级成机械闭合**。
- Commit -1 与 post-merge preflight 是不同相位：前者交付 runner oracle + validator；后者消费真实 A／P／15 artifacts。禁止重新混回一份 prompt。

## 已作废的路子

- 不把全套 plan 复制进每份 prompt：契约与判据细节仍以 design／cutover-plan／traceability 为单一事实源，prompt 只需 self-contained 到“独立执行者能按引用开工”，不是复制 80KB 文档。

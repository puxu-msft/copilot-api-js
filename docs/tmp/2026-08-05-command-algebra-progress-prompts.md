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

> 派活前建立，按 skill `session-closeout` §6b。预计多文件、多 commit、需把 82 个 task 分派到 Commit -1／post-merge preflight／Commit 0～8，属于必须建进度文件的形状。
> **只记 git 记不下来的三样**：剩余项（带验收判据）／在途意图／已作废的路子。每个语义 commit 一起更新并提交。

## 剩余项

- [ ] `prompts/README.md`：导航、阶段依赖 DAG、可并行边界、共享文件／合并顺序、通用红线
- [ ] Commit -1 self-contained prompt（T0.0a/b/c/e；独立 worktree；mutation hard rule；合 master）
- [ ] post-merge entry-evidence preflight prompt（A／15 runs／manifest／P／T0.0d）
- [ ] Commit 0～8 共 9 份 self-contained prompt
- [ ] 每份 prompt 引用正确的 design／plan／traceability／progress 路径，含目标、锚点、TDD、门、提交指引、红线指针
- [ ] prompt task 人口与 `cutover-plan.md` 双向对账，82 个 task 恰好各归一个执行 prompt
- [ ] `traceability-check.py` rc=0，prompt 专用 task-population checker rc=0

## 在途意图

- 第三层只翻译、分派第二层已经冻结的 plan；**不得新增签名、不得重裁待裁项、不得把 plan 的已知边界升级成机械闭合**。
- Commit -1 与 post-merge preflight 是不同相位：前者交付 runner oracle + validator；后者消费真实 A／P／15 artifacts。禁止重新混回一份 prompt。

## 已作废的路子

- 不把全套 plan 复制进每份 prompt：契约与判据细节仍以 design／cutover-plan／traceability 为单一事实源，prompt 只需 self-contained 到“独立执行者能按引用开工”，不是复制 80KB 文档。

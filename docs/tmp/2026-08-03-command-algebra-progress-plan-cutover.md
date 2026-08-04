---
slug: plan-cutover
base: 237fe27d
branch: master
worktree: /home/xp/src/copilot-api-js
plan: docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md
agent_id: planner（`AI_AGENT=claude-code_2-1-220_agent`；本 agent 表面读不到独立 agent id，只有会话级 `CLAUDE_CODE_SESSION_ID`）
session_id: 046d7295-e5ce-470b-a284-c721c6ce1cb8
---

# 进度 —— cutover-plan.md 撰写

> 由主会话在**派活前**建立（skill `session-closeout` §6b）。任务预计多轮、需读大量 RFC 与源码、有试错空间，落在「必须建」的一侧。
> **只记 git 记不下来的三样**：剩余项（带验收判据）、在途意图、已作废的路子。「我干了什么」git log 已经有了，别复述。
> **随每个实现 commit 一起提交**，别攒在工作区——被打断时未提交的在途意图会全丢。

> ⚠️ **本文件自己违反过上面这条**：四个 plan commit（`a0c5ae5d`／`1e2957e7`／`da4d4a21`／`2fc705f6`）与矩阵回填 commit（`3512301d`）**都没有带上它**，是被打断后由协调者点名才补的。V12 的观测值就是这个：`--first-parent` 对账会报出 5 条「缺进度更新」，且**集中在前段而非末尾**——这是「一次性补写」的形态。

## 剩余项

- [x] Commit 0～8 的逐 task TDD 步骤（每 task 一个 `T<commit>.<n>` id）—— **72 个 task，`T0.1`～`T8.7`**
- [x] factory／锚点表：被复用函数的 `file:line`，每条注明树
- [x] 回填矩阵 `traceability.md` 各表的 `plan task` 列，消掉全部 `_TBD_`
- [x] `traceability-check.py` rc=0 —— **已实跑，且四条 mutation 正控各自打中目标机制**（删 R-14 行 → `R-14 … no row in the matrix`；R-5 硬门挪 C2 → `production gate at C2 precedes the capability it depends on (C4)`；plan 加不被引用的 task → `plan task T9.1 is cited by no matrix row`；未变异 → rc=0）。变异跑在 `/tmp` 副本上（`MATRIX=`／`PLAN=` 覆盖），**真实文档未被改动**
- [x] **全文通读 + 逐条取证**（`reread-docs-after-writing` `[hard]`）—— 已完成，见 `368a9208`。**通读只抓到 2 处**（§11 说「四项」实为五项、Q1 门只数了 RFC 8 节而漏了脚本冻结的 2 份载体文档）；**其余 12 处全部是重新取证抓到的**，通读一次也看不出来——那 12 处每一处读起来都完全通顺。这正是「通读不能替代事实证伪」的当场实证。
  - **已知未验证项（不得当成已核）**：①`commandPortActivation` 两树零命中，无法确认它是 Commit 1～4 期间新引入还是 RFC 前瞻性命名——已在 T6.2 与 §12 标注；②所有「Commit N 时该断言会红／会绿」的预测都是**计划期预测**，未实跑（本轮不动 `src/`）；③RFC §7.2 的双向闭包**未实跑**，A／B／C／D 四集的具体成员以 T0.7 输出为准，本 plan 的锚点表只是 sanity 抽样。
- [ ] 交付回报：贴 `git log --oneline -1` 与 `git show --stat HEAD` 的原样输出（协调者的硬性核对项，理由见 HANDOVER「委派可靠性」——本轮此前有两个 agent 交回过与磁盘不符的完成报告）

## 在途意图

- **被打断的位置**：`3512301d`（矩阵回填）已落盘，接着要做进度文件与全文通读。API `Server error mid-response` 打断在这两者之间，**已提交的部分完好，未提交的只有这份进度文件**——与 §6b 记的本仓实测形态一致。
- **三处停点为什么写成「待裁」而不是给答案**：R-6 等级、Q1、§4.8 与选项 A 的冲突，三者都**没有 RFC 出处**可依。写进 `cutover-plan.md` §11，各附 3 个带量化影响的候选（`scope-ambiguity-then-ask` 要的是选项不是 yes/no），矩阵的 R-6 行也一律写「等级未定，见 §5」而不填。**自行推断撞证伪①（无 RFC 出处），两段同填「辅助门」撞矩阵 §0 明禁的压平**——后者尤其危险，因为它是「最省事的修法正好破坏判据要保护的东西」。
- **§11 新增了两条 RFC 里没有的待裁项，这是有意的**，不是越权：
  - **#4 entry commit 落在哪棵树**——RFC §7.1 只说「实际 entry commit」，没说树；而两棵树都不能直接当 entry（master 无 M1，feature 落后 47 commit、缺三处已修缺陷）。这是调度决策不是技术细节，`T0.1` 写成「在它裁定前不可开工」。倾向候选 4（隔离 worktree 先合 master），理由是与本项目 `docs-merge-before-execute` 的既定形状一致。
  - **#5 R-5 的 C1 辅助门段实际落在 Commit 2**——理由是 cardinality assertion 属 owner state primitives（§7.5 目标清单逐字含它，§7.4 没有）。判为**如实标注即可、不改矩阵**：`traceability-check.py` 只校验「production 硬门不早于其依赖能力」，辅助门落 C1 还是 C2 它不判，**正因如此才更需要人看一眼**。
- **矩阵 §6 为什么要新增一张表**：72 个 task 里有 30 个**不由任何 R-\*／O-\* 驱动**，而由 §7 的 commit invariant／越界判据／归零审计／文档同步驱动。不给它们出处，`traceability-check.py` 的「plan task 无出处」就会变成例行报错、失去鉴别力。**这不是为了让脚本变绿而编出处**——每条都指回具体的 §7.x／§4.x 小节。
- **锚点表为什么坚持两树并列而不给换算规则**：偏移**不是常数**（`client-sink.ts` 偏 9 行、`handler-v4.ts` 偏 7～40 行不等、`driver.ts` 有正有负）。写进 §12「未采纳」。

## 已作废的路子

- **想用 `fd` 找 golden 文件** —— 本机没装（`/bin/bash: fd: command not found`），用 `rg -l` 代替。别再试。
- **想按已知 API 名去数 emission 面** —— 这正是 HANDOVER 记的本轮已犯错误（漏掉 owner allocation-port 整类发射点，inventory §12 才补上）。plan 里改为**引用 T0.7 的闭包输出**，A／B／C／D 四集的具体成员一律写「以闭包输出为准，别照抄本表」。
- **想把 `commandPortActivation` 当既有符号写进 Commit 6 删除清单并给 `file:line`** —— **实测两棵树的 `src/` 都零命中**。改为在 T6.2 标注「到达本 commit 时先确认它存在再删，不存在就回报」，并写进 §12。给不存在的符号编行号，正是「跨一条没读过的缝规定行为」。
- **想直接照 RFC §7.2 的行号写 master 侧锚点** —— RFC 的种子行号全部锚在 feature 树（`ClientSink` 写的是 `types.ts:747`），master 上是 `:737`。已在 §0.1 与各锚点表显式并列，并加了「引用前重取」的命令。
- **想用 `withAllocatedRealBlock`／`writeBlockFrame` 的现有签名当 `openRealBlock`／`writeRealBlockFrame` 的终态签名** —— §3.4 明确终态应暴露 owner 验证的 opaque handle，现有签名是**迁移起点不是终点**。写进 §12。
- **想「两树只写一棵、另一棵按固定偏移换算」** —— 实测偏移**不是常数**，`client-sink.ts` 同一文件内就有 +9 与 +11 两种。已写进 §12。
- **想把两树的计数写成同一个数** —— 初稿照 RFC／HANDOVER 抄了「`ClientSink.write` 10 点」「`getDownstreamDeliverySession` 9 处」，两者都锚在 feature；master 实际是 11 与 7。**RFC 与 HANDOVER 的计数没错，错在我没标它们锚在哪棵树**。改为逐树并列。
- **想把 `wirePartialDelivery` 标成「两树皆有」** —— master 的 `src/` 零命中，它是 M1 引入的。同类陷阱：凡是 RFC §4.x 引用的「现状」锚点，都要先确认那个「现状」属于哪棵树。

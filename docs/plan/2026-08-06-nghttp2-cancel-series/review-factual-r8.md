# 事实证伪复评 R8

- **评审范围：** 仅评终态状态／证据引用改写；主树 `HANDOVER.md@af7fecc86df84b79e1b70bced408f8c8b3da97d99acd4e2b320e865b336d01e6`、`KICKOFF.md@c974c4cb697d1a79d830707700fafbff529740b350e16e72afec5d83e9a33d05`。不重审 R7 已判绿的技术机制。
- **总体 verdict：** 0 blocker / 0 major，可提交。
- **双视角覆盖——机械核对：** 对账两个状态头、`0840b929` 文件集合、14 份 review 路径、R7 verdict／技术 hash、相对链接、Git 可达措辞与草稿残留扫描。
- **双视角覆盖——第一人称执行：** 模拟从包含交接件的最终 commit 启动：先以该 commit 对 14 reports／supporting evidence 跑 `git cat-file -e`；缺任一即停止，全部存在才继续。该门不会把当前尚未提交的工作区误写成 HEAD 已有，也不会误拒正确的最终 commit。

## T1～T8 核验

1. **T1 通过。** `HANDOVER.md:3` 与 `KICKOFF.md:3` 均为“已评审·交接定稿”。
2. **T2 通过。** `git show --name-only --format= 0840b929` 恰列 8 个文件，与 `HANDOVER.md:26` 的 HANDOVER、KICKOFF、四份 supporting evidence、两份早期 review 完全一致。
3. **T3 通过。** 主树目录现有首轮 factual／successor 加各自 R2～R7，共 14 份；逐路径存在性均为 OK。`HANDOVER.md:26` 的 R7 两个相对链接均解析到现有文件；“首轮及 R2～R7”与实际命名集合一致。
4. **T4 通过。** `review-factual-r7.md:2-5` 与 `review-successor-r7.md:3-5` 均锚定终态化前技术 hash：HANDOVER `d7093f…`、KICKOFF `df522990…`，并分别给出 0 blocker / 0 major、0 blocker／0 major。
5. **T5 通过。** `HANDOVER.md:26`、`KICKOFF.md:5` 没有声称 reports 已在当前 HEAD；都要求先选“包含当前 HANDOVER／KICKOFF 的同一最终 commit”，再逐项 `git cat-file -e`。实测当前 HEAD 查 R7 为 rc=128，正好会被该门拒绝；提交齐全后的正确 commit 可通过。
6. **T6 通过。** `HANDOVER.md:26` 明确 job tmp／state／tasks／transcript 仅为 provenance 或必要深挖坐标，不是入口或状态真相源；KICKOFF packet 的同类坐标也标为 provenance、禁止重考古。
7. **T7 通过。** 两文件不再含“草稿／待复审／待提交／工作区 WIP”式交接件状态。`HANDOVER.md:9,130` 的“未提交 WIP／TBD”明确是接手现场须重取的易腐仓库状态，`A3/A4/Phase B` 未闭合项是任务事实，不是文档定稿状态残留。
8. **T8 通过。** 相对 R7 技术候选，终态改写只改变状态头与证据入口／R7 引用；preflight、两阶段 handshake、allowlist／PYFINAL、A/B 范围正文保持 R7 已审内容。当前 KICKOFF 的技术行从 preflight `:9` 起与 R7 所引命令及行号结构一致；未发现命令、packet 或技术 gate 漂移。

## 事实性发现

未发现 blocker 或 major。

---
name: methodology-ordering-gate-needs-a-trigger-that-reads-it
description: 写下「X 必须晚于 Y」前先问 X 由谁触发——触发方不读 Y 时那不是门只是愿望，正确改法是让 X 提前发生也无害
metadata:
  type: feedback
---

写下任何**顺序前置**（「X 必须晚于 Y」「Y 未完成前不得 X」）之前，先答一个问题：**X 由谁触发？** 若触发方**不读** Y，这条就不是门，只是愿望——它没有执行接缝，写得再郑重也拦不住任何东西。

**本轮实例（2026-08-08，History Worker Batch 1b 收尾）**：我把「临时证据清理必须晚于收尾提交进入 `master` 祖先」写成清理前置。但清理的触发方是 **Claude job 的自动回收**，它不读 Git ancestry——会话正常结束、崩溃或平台回收都会触发，而那句「不得允许」没有任何东西去执行它。终审 reviewer 判 major。

**正确的改法不是把门写得更严，而是换一个不需要门的形状**：让 X 提前发生也无害。具体做法是把长期价值**先行**落进已提交的持久接收者，于是清理何时发生都不删唯一副本；`master` ancestry 只保留它真正能管的职责——「可宣告集成完成、可清理 branch/worktree」。

**两个放大这个错误的形态**：
- **逐行复述**会让它看起来像已有 disposition。本轮那条失效的门被清单**逐行复述了 56 遍**，单看任一行都完整合规，只有回到「谁触发清理」这一问才暴露。
- 它是**判据之间留缝**而非某条判据写错：盯「产物有没有进提交」的检查（skill `session-closeout` 自验表 V7）**结构性地**看不到「我设的前置条件在物理上能不能被执行」。逐条核判据核不出来。

**Why:** 不可控的平台生命周期事件（job 回收、容器重建、缓存过期、CI 超时终止）被当成受控步骤来排序，是一类会静默失效的设计错误——它在纸面上完全自洽，只在真正发生时丢数据，而那时已经没人在看。

**How to apply:** 每写一条顺序前置，当场标注**触发方**与**它读什么**；两者对不上就改写成「提前发生也无害」。此形态已记入 skill `session-closeout` 的 `verification-log.md` 2026-08-08 节，标为「新增负样本、建议入表」，待独立评审决定是否升为正式自验条目——**未经评审不得自行改写 SKILL.md 正文**（instruction text 必评）。

**Related:** [[methodology-downgrading-a-gate-needs-a-reachable-trigger]]（同族：降级自评闸门时最容易只写成一句陈述、没有可达触发点）、[[feedback-pass-null-clean-not-self-validating]]（通过性结论不自证）。

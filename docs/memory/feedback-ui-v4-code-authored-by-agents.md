---
name: feedback-ui-v4-code-authored-by-agents
description: ui-v4 代码是 Claude+同伴 AI 会话写的，不是人类手搓——措辞与重构自由度据此调整
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d68f698b-2bc2-49f9-894e-5b0b082d679e
---

用户明确指出（2026-07-10、要求"记住"）：**ui-v4（乃至本项目）的代码是"你（Claude）和你的同伴（其他 AI 会话）"写的，不是人类手搓。**

**Why**：我之前反复用"手搓/hand-rolled"描述现有组件（如 shared/Modal），带了"人类劣质代码待 AI 取代"的隐含贬义框架，与事实不符——这些本就是 agent 协作产物（git 里有 AI 会话的 Radix migration P0–P3、headless-stack ADR 等）。

**How to apply**：① 措辞上不用"手搓"暗示低质，改用中性"既有实现 / 早期 agent 写法 / 现有组件"；② 重构顾虑放宽——`no-destructive-workspace-loss` 里"不是我创建的就别删"对这些**不适用**（都是 agent 创建，可自由重写，仍守可恢复性/git 历史底线）；③ 评价既有代码时避免居高临下，它是同一套 agent 协作标准的产物。

相关：[[project-ui-v4-shadcn-redesign-decisions]]。

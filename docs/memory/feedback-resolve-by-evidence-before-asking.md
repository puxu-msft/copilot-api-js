---
name: feedback-resolve-by-evidence-before-asking
description: 问之前先用代码+invariant 自解歧义；只在真正取决于用户偏好/风险取舍的分叉才问
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3327a03a-0bda-49b3-8f24-9230fe3ebdd8
---

任务有歧义时，**先**尝试用「读代码 + 既定 invariant/约束」自行裁决。若代码+invariant 已锁定答案，就自己定并把推理写出来，**不要问**。只有当答案**真正取决于用户偏好/风险取舍/价值判断**（代码无法揭示）时，才用 AskUserQuestion。

**为什么：** 两个相反的失败模式。问得不够 = 在真分叉上擅自决定（[[feedback_no_unilateral_action]] 警告的）。问得过度 = 仪式化提问，在代码本已决定的事上浪费一个来回。判别器：*用户偏好会改变答案吗，还是答案已被代码+invariant 钉死？*

**怎么用：** 先 grep/读。把证据和裁决就地写明（"歧义由代码实证解决，无需询问"）。只在确认是真分叉后才问，且带数据（[[feedback-give-user-decision-data-not-pitch]]）。

本会话实例（v4 P0）："transport.send 是否包 guardSseIterable?" —— grep 显示 guard 在 handler 层、client 返回裸 `events(response)`，结合"字节不变" invariant，答案被锁定（返回裸流）→ **不问**直接定。对比："双轨收敛选最小 A 还是完整 B?" —— 两者都满足 invariant，文档措辞甚至互相分歧，选择是真实的架构/风险分叉 → **问**，带 A/B + 影响面数据。**当 spec 自身在高风险决策上内部不一致，这本身就是强烈的"该问"信号。**

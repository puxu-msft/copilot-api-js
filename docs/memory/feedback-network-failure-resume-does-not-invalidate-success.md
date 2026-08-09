---
name: feedback-network-failure-resume-does-not-invalidate-success
description: 网络／API 中断必须原会话强制 resume，但已完整成功取得的样本不追溯失效，也不因此全量重跑
metadata:
  node_type: memory
  type: feedback
  modified: 2026-08-08
---

网络／API／stream 中断后的恢复只有一条路：保存原 session／agent 身份，使用对应运行时的 resume 接口原样继续；不设妥协性重试上限，不换模型、不新派替代、不缩验证范围。明确 context-window 终态才按容量交接协议换实例。

**非追溯边界：** 恢复纪律只约束失败／截断的调用。已经完整返回、可解析且通过自身完整性门的样本或报告继续作为证据；不能把“失败必须原样 resume”扩大成“清空此前全部成功证据并从头重跑”。

**Why:** 2026-08-08 实现 `delivering-in-validated-batches` skill 时，先出现了把网络失败设成有限重试的错误，随后又反向过度修正为“既有成功样本全部失效”。用户明确裁决：网络失败原样 resume 是强制纪律，但已取得的完整样本仍有效。

**How to apply:** 每个长运行预先保留可恢复身份；失败时只恢复该身份。验收账本分别记录“成功产物是否完整”和“失败调用是否按原身份恢复”，两者不得互相冒充或追溯污染。

**Related:** [[feedback-backend-flakiness-must-sendmessage-resume-no-alternatives]]、[[feedback-resume-agent-always-sendmessage-never-agent-tool]]

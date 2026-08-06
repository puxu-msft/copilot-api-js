---
name: feedback-block-level-delivery-is-project-axiom
description: 本项目交付形状公理=block-level，绝不提供逐 token 流式体验；response-level 仅作实验选项；冲突的设计/代码/文档要摧毁而非并存
metadata:
  node_type: memory
  type: feedback
---

**本项目的客户端交付形状是 block-level（按完整内容块提交），这是公理不是权衡。绝不提供逐 token 流式体验**——用户 2026-08-02 原话：「用户曾经要求，绝不提供流式体验，本项目的一切都建立在 block-level（有实验选项扩展到 response-level），这个原则要记下来！任何冲突的内容都要摧毁」。response-level（整响应缓冲）只作为**实验性扩展选项**存在，不是另一个平级形状。

**Why:** 逐 token 实时转发使「已提交前缀」变成半截块——partial text 已在客户端 wire 上却不在 ledger 里、partial tool_use 的 `partial_json` 无法闭合，于是所有断流恢复腿（透明重试 / 续写重试 / 静默终止）都要处理不可回滚的半块状态。block-level 让「已提交前缀恒为完整块序列」成为不变量，三条恢复腿才干净可证。流式体验的损失是**已被用户裁决接受的既定代价**，不是每次设计要重新权衡的开放项。

**How to apply:**
- 提案任何交付/恢复形状时，**不得**以「保住逐 token 流式体验」为理由降级或否决 block-level 方案。我 2026-08-02 提过「text/thinking 逐 token 实时 + 只缓冲 tool_use」的混合方案，被用户当场推翻——这类混合正是要摧毁的对象。
- 遇到 live（非缓冲）转发路径、`protect_streaming_generation: false` 这类「退回实时」的开关、以及文档里「代价是下游流式体验」的权衡措辞，按 CLAUDE.md「无向后兼容负担」**强制迁移到 block-level 并删除退路**，不做双轨并存。
- 唯一允许的另一个档位是 response-level，且必须标注为实验选项。

**Related:** [[project-block-level-buffered-retry-execution]] [[project-continuation-retry-sequential-anchor]] [[feedback-existing-code-has-no-authority-dont-accommodate]]

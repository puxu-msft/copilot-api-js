---
name: feedback-richest-data-flow-store-complete-no-pruning
description: richest-data-flow 硬约束=后端每阶段数据必须完整存；"无消费者"/"重复"/"与另一腿字节相同"都不是裁剪数据模型的理由；前端选择性展示≠后端可不存
metadata:
  type: feedback
---

设计 History HTTP header 捕获时，我（和默认持 DRY/YAGNI 的 subagent）用"无 UI 消费者""与另一腿字节相同""冗余双写"为由**裁剪数据模型**——砍掉 per-attempt headers、提议删除 `httpHeaders.inboundResponse`（Proxy→Client 第四腿）。operator 纠正：这违反本项目 richest-data-flow 硬约束（权威见 ADR `docs/decisions/2026-07-05-richest-data-flow.md`，CLAUDE.md / DESIGN.md 引用之）："History 记录请求/响应生命周期所有可观测原始数据，**后端存储必须完整，前端展示可选择性呈现**"。

**Why**：History 是忠实的可观测记录。代理是带重试的请求/响应中继，生命周期有四条**真实的边**（①Client→Proxy 请求 ②Proxy→Upstream 请求[per-attempt] ③Upstream→Proxy 响应[per-attempt] ④Proxy→Client 响应），每条都是不同阶段的真实事件。"当前两腿字节相同"是巧合、非语义相同；"无 UI 消费"只反映前端**选择性展示**、绝不意味后端可不存；"无数据源"常是**没接线**而非真无源（如 ④ 的源是 handler 写出点 `c.res.headers`，只是没捕）。

**How to apply**：永不为 DRY/YAGNI/无消费者**裁剪数据模型**。reviewer（默认 YAGNI）说"无消费者→删/砍"时，对数据模型一律拒绝——每个阶段/每个 attempt 自然记录其完整字段，后端全存。可以做的是**捕获机制（HOW）**的收敛（一个字段多个写入者→单一干净 owner，这是 single-source-of-truth 的写路径，不是删数据）；不可做的是**数据模型（WHAT）**的裁剪。"该建而非该删"：无 producer 的真实阶段字段→去建数据源接线，不是删字段。呼应 subagent-explicit-rubric（subagent 默认 YAGNI 与本项目"完整"轴冲突，派活写明裁判轴仍可能漏，richest-data-flow 须显式覆盖）+ [[feedback_complete_root_cause_fix]]。活案例 docs/spec/history-http-header-capture.md（v1-v5 裁剪→v6 完整四腿模型逆转）。待全面审计其他 RFC 见 [[project-audit-rfcs-data-model-pruning]]。

---
name: feedback-verify-facts-before-superlative-completeness-verdict
description: 下「最好方案 / 只治一半 / 漏了症状X」这类完备性或最优判断前，先实测每个支撑它的事实（尤其 absence/negative 断言），否则会给出自信但错误的建议
metadata:
  type: feedback
---

下「这是最好的修复吗 / 某方案只治一半 / 还漏了症状 X」这类**完备性或最优性**判断时，该判断依赖的每个支撑事实都必须**先实测**，尤其是 absence / negative 断言（「features 不进 history」「telemetry 会丢」「没有消费者」）——它们最容易凭结构推断而错，且一旦错，会把一个正确方案误判为「不够好」，或凭空造出一个不存在的症状。

**本会话实例（用户评「非常深刻的教训」）**：TUI 面板永久转圈 bug 调查中，我两次在验证前下结论且都错：
1. 用户说「代理没结束请求」，我先入为主盯**客户端**（真 SDK 复现证客户端拿干净 400 无挂起）——方向错，用户拉回后才发现是 TUI 展示层。
2. 用户问「TUI 防御是最好的修复吗」，我脱口「不是，它只治一半、漏了症状②遥测丢库」——但一实测 `recordFeature` 只发事件不写 ctx、`toHistoryEntry` 无 feature 字段、HistorySink 对 feature_applied 是 no-op、telemetry sink 也不收，**症状②根本不存在**，features 本就设计上不进 history。TUI 消费侧防御恰恰**就是**最好的根因修（正确的层、一处覆盖全类晚事件），我先贬低它才是错的。

**Why**：完备性/最优断言是「voice 权威」的自我背书，最需要独立 ground truth 校验（[[feedback-pass-null-clean-not-self-validating]] 的同族）；absence 断言尤其危险——「没有 X」无法靠看一处代码证实，只能靠追全部生产/消费/落盘通道。凭推断给的「最好」判断，用户会当真采纳，错的代价直接落到决策上。

**How to apply**：被问「是不是最好 / 够不够完整」时，先列出该结论依赖的事实清单，逐条实测（真数据探针 / 追全通道 / 复现），再表态；对 negative 断言用正样本反证（先证检查能抓到存在的情形）。宁可说「让我先验证支撑这个判断的几个事实」也不要脱口给自信结论。→ user skill `verifying-authoritative-claims` / 项目 skill `empirical-verification`。相关：[[feedback-multidim-completeness-audit-before-claiming-done]]、[[methodology-reasoned-safe-not-tested-producer-wire-oracle]]。

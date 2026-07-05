---
name: methodology-broken-reference-supply-vs-delete
description: 已提交代码里指向缺失符号的编译错误有两种相反修复——补符号 vs 删引用；按消费者契约+独立 oracle 裁决，别反射式"让它编译"
metadata:
  type: feedback
---

已提交代码里"引用了不存在的符号"导致的编译错误，修复有**两种方向相反**的形状，绝不能反射式选"补上符号让它编译"：

1. **补符号**——引用是对的、符号定义滞后/丢失（如并发行级合并丢了配套定义）。
2. **删引用**——引用本身是 aspirational/基于错误假设、违背该函数的契约，符号根本不该存在。

**Why**：本会话踩过——`errorLabelFor` 引用 `ENDPOINT.GEMINI`（常量里没有），我第一反应是"②尚未实现→加 `GEMINI` 常量"让它编译+测试过，还留下一个永不触发的死分支。后来独立 oracle（via-responses 集成测试断言 + legacy client 的实际标签：`chat-completions-client`/`responses-client`/`anthropic-client` 按**上游路由**选标签）证明该函数契约是"legacy parity 按上游 endpoint 标签"，而 gemini 翻译成 `/chat/completions` 上游、legacy 根本没有 generateContent 标签——所以 GEMINI 分支三重错误（永不触发 + 不匹配 legacy + 假设 gemini 有独立上游 path）。正确修复是**删除**这个 aspirational 死分支，不是补常量。我把"补常量"先做了又推翻成"删引用"，多走一趟。

**How to apply**：碰到"引用缺失符号"的编译错误，先读该消费者（函数/调用点）的**契约**（docstring 明说的不变量、它在 legacy/参考实现里的对应行为），再用**独立 oracle**（既有断言其意图的测试、参考实现、真实对端）裁决引用该不该存在——而非默认"加上去让它绿"。"让它编译"是最低标准、不是正确性判据。这是 [[feedback-pass-null-clean-not-self-validating]] 的 doc-vs-code 三分（陈旧/未实现/缺陷）在**代码符号引用**域的第 4 种："引用基于错误假设→删"；oracle 用法与"测试过/编译过不自证正确"同源（见 [[feedback-pass-null-clean-not-self-validating]] ②③）。

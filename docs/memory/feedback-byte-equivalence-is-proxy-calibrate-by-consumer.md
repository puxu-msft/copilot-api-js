---
name: feedback-byte-equivalence-is-proxy-calibrate-by-consumer
description: 逐字节等价是手段非目的;按消费者分三层校准严格度,该覆盖就覆盖
metadata:
  type: feedback
---

逐字节 golden 等价不是目的、是**手段**——真 invariant 是"对**在意的消费者**无可观测行为变化"。逐字节只是它的一个代理,贴合度取决于消费者是谁,按三层校准严格度:

1. **转发给客户端的响应 SSE**(Phase 0/4):消费者是不控制的、苛刻的外部 SDK 解析器(Claude Code/Anthropic SDK/`@ai-sdk/openai`),对 `signature_delta` 出现、`content_block` index 连续/densify、`event:` 行、帧顺序有硬期待。这里逐字节≈契约本身,**死磕**。语义等价但字节不同的帧流能直接挂客户端(见 thinking shim 400、fix-stream-ids、tool_use id 引用)。
2. **发往上游 GHC 的 wire payload**:真 invariant 是"GHC 接受 + 同结果",逐字节是**比需要更严的廉价代理**(key 序/空白 GHC 不在乎)。终审是 GHC 这个独立 oracle(见 [[feedback-self-consistent-needs-independent-oracle]]),非字节自洽。
3. **history/可观测记录**(Phase 2 的 pipelineInfo/effectiveRequest):消费者是自家 UI,逐字节只是**回归 tripwire**(我重构有没有手滑改了记录的数据),可覆盖。

**Why:** 这批工作的命题是"behavior-preserving 迁移",字节 diff 是证明它最便宜的诚实 oracle,专抓功能测试漏掉的帧重排/漏发多发/payload 漂移([[methodology-golden-fixture-pre-capture]])。收益不对称:golden 误报查 5 分钟 vs 语义漂移上线在 opus 长 thinking 沉默后悄悄挂客户端=难查 outage。但它绝不神圣——真实纪律是"默认逐字节、当它冻结一个错误行为时带文档覆盖"。Phase 2 reject 路径就是实例:故意没锁 reject 的 pipelineInfo,否则等于冻住"给要拒的请求白做 sanitize"这个错误行为(呼应 [[feedback-optimize-long-term-maintainability]] 别自设"严格零改动"约束)。

**How to apply:** byte-critical 响应集(Phase 4)死磕逐字节;请求/history 侧**优先 oracle/结构等价**而非 inline 字节字面量——Phase 2 对 effectiveRequest 断言 `toEqual(runAnthropicRequestRewrites(...))` 证明"路径应用了链"这个性质,对偶然噪声(注入的 20 个 Claude Code stub)鲁棒,这是逐字节的精炼非放弃。任何时候逐字节挡住明确更优架构→覆盖它 + 文档化(像 reject 路径)。**信号**:发现自己在 inline-lock 一个纯内部、纯噪声的大对象=该换 oracle 了。

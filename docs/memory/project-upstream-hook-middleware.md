---
name: project-upstream-hook-middleware
description: 上游 Transport hook 中间件特性（spec 定稿中，待 subagent 评审后转 plan）
metadata: 
  node_type: memory
  type: project
  originSessionId: 7a99eb70-2a38-46f6-90fe-c6c9b3c41e28
---

上游 ad-hoc hook 中间件特性——在 proxy 上游边界引入 driver 编排的多挂载点 hook，让开发者用 config 声明的 TS 文件 mock/拦截/录制回放/注入故障上游响应，不真发 GHC（复用完整处理管线，只 mock 上游那一段）。源起 2026-07-12 cache_control 剥离实测中「验证不得不真发 GHC、无法造 400/畸形帧测 reactive 学习腿」。

**权威文档**：[docs/spec/2026-07-12-upstream-hook-middleware.md]，取代 kickoff `docs/plan/2026-07-12-upstream-hook-middleware-KICKOFF.md`。

**已敲定决策**（brainstorming 2026-07-12，spec v2 经 2 轮对抗评审+实测修订）：① 注入收口进 `createPipelineDriver`（driver 是 transport 唯一消费者，6 处 handler 构造点不改）② driver 编排三挂载点 `onRequest`(**runRequest 内一次性点、循环外**，评审 H1 修正) / `onExchange`(包裹 transport.send driver.ts:310 核心) / `rewriteUpstreamFrame`(逐帧，**driver.ts:446 采样后**，改名避与既有 RunResponseOpts.onUpstreamFrame 混淆)，同 hook 按参数自辨、无声明式匹配 ③ mock = 高层 helper + raw 逃生口；`mockUpstreamError` 须产真 HTTPError+responseText 且带命中各 reactive 策略的判别性 body 预设(评审 H3) ④ 录制-回放**复用 history.db** `upstreamResponse.sseEvents`，raw 只存 data 负载→Anthropic 无损/CC·Gemini 有损须格式分层(评审 H4) ⑤ 热重载**仅 API** `POST /api/hooks/reload`，机制=**data-URL**(`Bun.Transpiler`→`import("data:...")`)非 `?v=`(Bun 实测忽略 query，见 [[reference-bun-esm-cache-busting-query-fails-data-url-works]]) ⑥ 安全 internal-tool-posture：默认 enabled:false + warn-continue 绝不杀进程。

**承重不变量**（评审 BLOCK-1/H2 双确认）：hook mock/改写帧进 history **上游-original track 必打可辨识标记**（扩 `SseEventRecord.synthetic` 增 `hook-mock`/`hook-rewrite`/`hook-replay`），违反 richest-data-flow ADR 则毒化诊断真相；上游轨录 pre-hook 真实帧、改写只进 forwarded。config 声明态 vs 生效态脱钩(评审 HIGH-2)，加 `GET /api/hooks` 查生效态。config 触点漏 `mergeConfigIntoDocument`(评审 HIGH-1)。

**正交微改动**（单独 commit）：根路径 `/` [server.ts:88] 从 `c.text("Server running")` 改 302 重定向到 `/openapi.json`。

进度：spec v2 定稿（全部承重断言亲手实测核实：Bun ?v= 失效/data-URL 可行/别名解析/driver 三点先后/L1×L2 调用）→ 待用户审 spec → writing-plans。异模型 gpt 第二意见因 vendor 拒绝失败(正是本特性要解决的问题)，已用第二 Claude 角色补位。相关：[[feedback-config-philosophy-separate-compat-and-warn-continue]] [[feedback-synthetic-data-must-be-distinguishable-from-real]] [[reference-bun-esm-cache-busting-query-fails-data-url-works]]。

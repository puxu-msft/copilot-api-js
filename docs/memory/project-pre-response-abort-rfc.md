---
name: project-pre-response-abort-rfc
description: pre-response abort 处理 + opus 长思考保活 RFC——①②设计就绪可实现，③(延迟-commit 保活)设计已多轮收敛但实现卡在 Q2 实测，等下次报错再做
metadata:
  type: project
---

排查 opus-4.8 流式请求在 pre-response（上游 292s 没回响应头）被客户端断开、产生 `[FAIL] ... The operation was aborted.` + `[ERR] Unexpected non-HTTP error` 双日志，产出 RFC `docs/rfc/pre-response-abort-handling.md`（设计稿，**尚未实现任何代码**）。三个缺陷：

- **①** `forwardError`（`src/lib/error/forward.ts`）不分类 abort → catch-all 出 500/"Unexpected"；应分 504（response_header 超时）/499（客户端断开，靠 `c.req.raw.signal.aborted` 判别，非 error.name——http2-client 抹掉了 TimeoutError 身份）。
- **②** pre-response 客户端断开记 `failed` 而非 `aborted`（与 mid-stream 路径 `ctx.abort()` 不一致）。② 当前仅 Anthropic handler，CC/Responses/Gemini 待 Q7 决议是否扩面。
- **③** pre-response 静默无客户端保活（240/120s fake-sse 心跳在上游响应头到达后才起）。采**延迟-commit（grace window）**：`stream:true` 请求先 `Promise.race([runRequest, graceTimer(preStreamGraceSec)])`，grace 内上游回头走现状出正确 HTTP 状态码（零发散），耗尽才提前开 200 SSE + **立即采样首 ping**（`sink.emitPingOnAttach`，不能用不采样的 `writeSynthetic`）。可配置 `anthropic.pre_stream_grace`（0=禁用、完全 bypass race）。

**状态（2026-06-22）**：①②（C1/C2）设计收敛、可直接实现。③（C3b）经 round-A（3 视角并行）+ round-B（对抗复审）**判定收敛、无设计层 CRITICAL**，含两前置子步 C3b-pre1（抽 `mapHttpErrorToEnvelope` 纯函数，因 forwardError 分派耦合在 `c.json` 内联）、C3b-pre2（sink 加 `emitPingOnAttach`）。

**为何还没实现 / 触发条件**：③ 卡在 **Q2 oracle 实测**（make-or-break）——POST-COMMIT 把上游错误降级成 200+SSE error 帧，双 oracle 已证 Anthropic SDK 对流内 error 走 `.status===undefined` 裸 APIError + 零自动重试（401/400/429 还会被旧 `anthropicStreamErrorType` 拍平成 `api_error`）。须用真实 Claude Code/SDK 实测：① 它对"200 流首事件即 error 帧"的 429/401/400 分支；② Claude Code 真实请求超时类型/阈值（定 grace 默认值，~258s 是单方声称未 pin）。用户决定（2026-06-22）：**等下一次真的遇到 pre-response stall 报错再做 Q2 实测 + 实现**，先记着。下次出现 `[FAIL] ... operation was aborted` 且 history `inboundResponse:null`/`sseEventsLen:0` 即触发信号——用 [[empirical-probe-via-history-api]] 从 4141 后端拉真实 entry 确认。

关联 [[project-v4-pipeline-rearchitecture]]（同属 v4 管线域；注意有[[git-concurrent-sessions-pathspec-commit]] 说的并发会话在做 L2 streaming，③ 的 sink/driver 改动可能与之相邻，实现前先看活的架构现状表）。

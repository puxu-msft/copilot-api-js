---
name: methodology-stream-eof-not-completeness
description: "流式代理里\"上游干净 EOF\"≠\"流完整\"——必须校验协议终止符，否则截断流被静默误判成功；且检测要枚举所有平行传输 handler"
metadata: 
  node_type: memory
  type: project
  originSessionId: 155eb0ce-da7c-4672-96e1-3304dbb031a8
---

流式代理把"上游连接干净 EOF"直接当成功 complete，会**静默误判上游中途截断**（GHC mid-stream cutoff：发完残缺内容后干净关流，缺协议终止符）。症状是**代理端零异常**（打 `[OK]`、history 记成功）、**客户端却报错**（如 Anthropic SDK "Stream ended without receiving any events"）——典型的静默失败/误分类（同 [[methodology-persistence-swallow-plus-lossy-fallback-loses-data]] 那一类）。

**根因判据**：流是否完整不能看传输层 EOF，要看**协议终止符**是否到达。各格式 accumulator/meta 已有 sticky 终止字段可直接判：Anthropic `message_stop`（加 `sawMessageStop`）、OpenAI CC `acc.finishReason`、Responses `acc.status`（completed/incomplete/failed 都算合法终止，判 `===""` 而非"非 completed"，否则误伤合法 incomplete）、Gemini `getStreamMeta().finishReason !== FINISH_REASON_UNSPECIFIED`（且要在 flush 写出误导终止帧**之前**判）。缺终止符→改判 `ctx.fail`（`[FAIL]`+原因+history 记失败，保留残缺 content 投影）+ 给客户端合成格式专属 error 帧让 SDK 拿干净终止符。

**诊断手段**：从运行中后端 `/history/api/entries/:id` 拉真实数据（见 [[empirical-probe-via-history-api]]），对比 top-level `sseEvents`（raw 上游）vs `inboundResponse.sseEvents`（forwarded）的**末帧类型**——正常流末帧是协议终止符，截断流末帧是 content delta。

**方法论（这次 audit 抓到的真实漏网）**：一个格式可能有**多个平行传输 handler**（Responses 有 HTTP + WS 两个独立 handler、都走 `runResponseSink`）。给"完成分支"加检测时必须**枚举所有消费 `runResponseSink` / 所有 `outcome==="complete"` 分支的 handler**（grep 全仓），只改一个传输不算完整——这是 [[feedback-fix-all-comparison-sites]] 在"平行传输 handler"场景的实例。注意各传输的 sink 能力不同（WS 的 `makeWsSink` 无 `writeSynthetic`，要用 `sendErrorAndClose`+1011）。

**架构天花板（已修正）**：流式 post-content 截断在**默认 live 路径**下无法透明重试——S4 重试环在拿到流对象瞬间即退出、截断在 S5 消费帧时才暴露、帧已逐帧转发、无重入路径。但**全缓冲就能**：缓冲整个响应、只在 `sawMessageStop` 确认后才一次性 commit，则截断时可丢弃缓冲、回 S4 重取上游流透明重试（客户端缓冲期只收 heartbeat ping）——这是 L2 事务化缓冲重试（`docs/archive/2606-landed-rfcs/streaming-upstream-rst-buffered-retry.md`），复用本检测的 `sawMessageStop` 作 commit 门控。代价：延迟（等整次生成）+ 内存（buffer）+ 输出重烧，且**不做续传**（Anthropic 协议不支持 resume 半截 tool_use，只整请求重发）。L1（检测+error 帧）是地板/兜底，L2（缓冲重试）是 opt-in 保护，二者由 `sawMessageStop` 串起。早先"架构上不可能透明重试"的论断错把 first-content-gate 的能力上限当成了任何缓冲都不行。完整设计见本项目 `docs/spec/upstream-stream-truncation-detection.md` §3.3。

---
name: project-pre-response-abort-rfc
description: pre-response abort 处理 + opus 长思考保活 RFC——①②④⑤+C3b-pre1+P1 Q2 GO+P2(③ 延迟-commit)+P3(keepalive 命名重整)+P4(reaper 0-unhandled repro)全部已落地，RFC 100% 完成；③ 对 stream:true 请求 race grace timer 提前开 200 保活，POST-COMMIT 错误降级富 SSE error 帧
metadata: 
  node_type: memory
  type: project
  originSessionId: 79ff48bb-02b7-4df3-a1f9-06f727721113
---

排查 opus-4.8 流式请求在 pre-response（上游 292s 没回响应头）被客户端断开、产生 `[FAIL] ... The operation was aborted.` + `[ERR] Unexpected non-HTTP error` 双日志，产出 RFC `docs/spec/pre-response-abort-handling.md`。三个缺陷：

**RFC 主体已全部交付（2026-06-23）**：①②④⑤ + C3b-pre1 + P1 Q2 GO + **P2(③ C3b 延迟-commit) + P3(keepalive 命名重整)** 全落地。commit 序列:C3a `6e04f69` golden → P3-naming `afd2370`(`stream_fake_sse_heartbeat`→`stream_keepalive_ping_sec` 默认 45 + 新 `stream_keepalive_grace_sec` 40 + compat 迁移；`protect_streaming_heartbeat` 留 L2 族) → C1 `5239328`(`pumpAnthropicStreamingV4` 接收注入 sink，byte-equiv) → C2 `08b2124`(`post-commit-error.ts` 富错误帧 pure helpers) → C3b 本体(race/dispatch 被并发 agentId 提交 `6dee399` 误扫入,配置+测试+L1/L2 修复 `e3ad9e6`)。落地形态见 RFC §5 C3b 行 + DESIGN「活的架构现状」流式写出行。**坑**:并发会话 `git add` 整文件把我在飞的 C3b handler 体扫进它的 agentId 提交（[[sed-touched-files-bundle-inflight-work]] 实例）——用 pathspec 补齐其余、不 rewrite 并发 commit。**P4 已落地**(reaper-真-abort 0-unhandled repro,强化 ④:`tests/transport/reaper-abort-unhandled.it.test.ts` 4 例 + `exp/reaper-real-abort/repro.ts` abort-driven 负对照证 observer 是因;harness 折≥2 signal 走 AbortSignal.any prod 路径)——**RFC 100% 完成**。subagent 对抗复审 C1/C3b/P4 均无 CRITICAL（修了 L-1 首 ping 入 try、L-2 失败也快照 forwarded、P4 的 HIGH-2 AbortSignal.any 保真 + MEDIUM-2 负对照因果）。

三缺陷原貌：

- **①** `forwardError`（`src/lib/error/forward.ts`）不分类 abort → catch-all 出 500/"Unexpected"；应分 504（response_header 超时）/499（客户端断开，靠 `c.req.raw.signal.aborted` 判别，非 error.name——http2-client 抹掉了 TimeoutError 身份）。
- **②** pre-response 客户端断开记 `failed` 而非 `aborted`（与 mid-stream 路径 `ctx.abort()` 不一致）。② 当前仅 Anthropic handler，CC/Responses/Gemini 待 Q7 决议是否扩面。
- **③** pre-response 静默无客户端保活。**已落地**:`stream:true` 请求 `Promise.race([runRequest, graceTimer(streamKeepaliveGraceSec)])`，grace 内回头走 `runUpstreamSettledPath`(现状零发散)，耗尽 COMMIT 开 200 + 立即 `sink.write` 首 ping，POST-COMMIT 错误经 `post-commit-error.ts` 降级富 SSE error 帧(signal-state 判别 client>reaper>timeout，pre-response reaper-cancel 是普通 AbortError 非 StreamReaperCancelError)。config `anthropic.stream_keepalive_grace_sec`(默认 40，<60s 硬约束)。C3b-pre2(原拟 sink `emitPingOnAttach`)实现期判定冗余:`ClientSink.write` 已是采样写,直接用。

**③ Q2 已实测裁决 GO（2026-06-22，[exp/q2-oracle/REPORT.md](../../exp/q2-oracle/REPORT.md)，详见 skill `claude-code-connection`）**：用真实 `@anthropic-ai/sdk` 0.105.0 + 真实 `claude` CLI 2.1.185（独立 oracle，self-consistent-needs-independent-oracle）+ 受控 mock 上游（`exp/q2-oracle/mock-server.ts` 可静默/ping/HTTP-error/SSE-error/commit-then-error；CC 经 `--settings` 覆盖盖过 user settings 的 4141 base URL，prod-faithful = custom URL + `copilot-api` token 不设 `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`）实测：
- **(a)** CC 请求超时 = **idle 型、≈ 60s、自动重试**（源码 `db()` 在 body-idle watchdog 激活时 `timeout:!1` 关 SDK 600s 总超时 + 行为 ping@30s 存活 330s/ping@45s 存活 225s 双证；8 abort 样本全 60.0–60.2s，first-party 与 prod-faithful 一致）。incident 的 ~292s 非单次自动超时（用户中断/headless 重试风暴）。→ **grace 硬约束 `< 60s`、默认定 40s；heartbeat 须 < 60s（③ 原稿/既有 `anthropicFakeSseHeartbeat` 的 120s 太慢、失效，须改 30–40s）**。
- **(b)** 错误帧**部分等价**：`error.type` 富帧保真（`mapHttpErrorToEnvelope` 已落地 `3e4b3cd`）→ 各类错误正确显示（401 触发 CC "请 /login"）；**401/400/不可重试类完全等价**（不重试本就正确）；**仅 429 及 5xx 可重试类真发散**（CC 对 HTTP-429 重试 ≥7×、对 200+SSE-error-429 一次即弃）。E3 证流式 commit 后即便真错误 CC 也不重试（协议固有）→ 唯一真发散 = 长 stall>grace 后才到的可重试错误。
- **裁决 GO**：keepalive 机制实证可行 + 残余被延迟-commit 收窄到病态少数 + 显示保真。**P2（C3b）可启动**，余阻塞 = **并发 L2 字段冻结 + §4.2.1 的 2 新 CRITICAL（pump 自建 sink / decideRoute resolve 非 throw），非 Q2**。RFC §6 Q2 / §4.2.3 grace 默认 40s / §4.2.5 / §5 C3b 行已据实测更新。

关联 [[project-v4-pipeline-rearchitecture]]（同属 v4 管线域；注意 CLAUDE.md `concurrent-sessions-line-coexistence` 说的并发会话在做 L2 streaming，③ 的 sink/driver 改动可能与之相邻，实现前先看活的架构现状表）。

**第二起 incident（2026-06-22）增补缺陷④⑤**（详见 RFC §2 + skill `debugging-server-crashes`）：911s stale-reaper force-fail + 未捕获 AbortError 崩服务器。
- **⑤（已修，commit `c824df4`）**：孤儿（无 awaiter）上游 fetch 的 abort 拒绝经 `main.ts` unhandledRejection→exit(1) 崩整服务器；修在产生点 `http2Fetch` 挂防御性 `withRejectionObserver`。
- **④（已落地 `d6eacf0`(C4a)+`4bd6850`(C4b)+`67b6eca`(WS)）**：reaper 装牙齿——独立 `StreamReaperCancelError` 第三 provenance（**不折进 `guardSseIterable` 的 `clientSignal`**，否则误判 reaper-cancel 为客户端断开→静默断流+错记 `aborted`）；`RequestContext` 加 `lifecycleSignal`+`reapInFlight()` 真取消在飞上游 fetch。**全传输覆盖**:HTTP h2 + Responses 上游-WS（`67b6eca` 经 `responses-transport`/`upstream-ws-attempt` 折 `reaperSignal`）。reaper-真-abort 的 0-unhandled repro 已落地（P4：`tests/transport/reaper-abort-unhandled.it.test.ts`）。实现洞见见 [[methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit]]（reaper-cancel→既有 stream-error outcome 复用全 6 站点 + 穷尽 `Record<StreamErrorKind,_>` 当站点审计）。

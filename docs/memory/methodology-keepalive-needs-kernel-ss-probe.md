---
name: methodology-keepalive-needs-kernel-ss-probe
description: 验证 socket keepalive 必须 ss 看内核 timer;dispatch 被调用/请求 200 都不等于 keepalive 生效(pass-null 盲点)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 23c7e548-1ad2-4ce2-9ae4-0445eb6ca9d2
---

验证一个连接是否真有 TCP keepalive,**唯一可信证据是 `ss -tno` 看到该连接(按 localPort 匹配)带 `timer:(keepalive,Nsec,...)`**。

**Why:** 我曾在调研 undici-on-Bun 时,只验证了"子类化 Agent 的 dispatch() 被调用"+"请求返回 200",就得出"keepalive 生效"——错。dispatch 被调用只证明 dispatcher 被消费,不证明它的 connect 选项落到了内核 socket;请求 200 只证明能连通。这是典型的 pass-null 盲点(肯定性中间信号≠目标结果)。后被另一 subagent 用 ss 推翻,再经我亲手 ss 裁决坐实。两个 subagent 实测结论冲突时,亲自写最小 ss 探针裁决(呼应 [[feedback_reviewer_verify_critically]])。

**How to apply:**
- 探针发请求到**慢响应/可保持打开**的端点(httpbin delay 或本地 server),在响应**未结束时** `ss -tno | grep <localPort 或 :443>` 抓,保持 socket 够久、多抓几次排除时机假阴性。
- 用**项目真实生产函数**(如 `upstreamFetch`)发请求,不要用孤立的手搓 import——探针接线须代表生产([[methodology-probe-harness-must-match-prod]]),否则可能无意中走了真 undici/绕过 shim,结论不适用于生产裸 import。
- 区分 L7 "HTTP keep-alive 连接池复用"(`Connection: keep-alive`)与 L4 "TCP SO_KEEPALIVE 探针"(内核 timer)——库的 `keepAlive` 选项常只是前者,我们要的是后者,只有 ss 的 `timer:(keepalive)` 字段能确认。
- delay 参数(TCP_KEEPIDLE)也要验精确:设 15000ms 应看到 timer 从 ~14sec 倒数,而非系统默认 7200s(那说明 idle 没设上,如 Bun.connect 的坏参数)。

具体环境结论见 [[reference-bun-fetch-tcp-keepalive]]。

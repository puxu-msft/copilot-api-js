---
name: methodology-observe-client-giveup-serverside-not-ladder
description: 测「客户端等多久才放弃」别跑阶梯夹逼——让服务端静默到超出容忍度、从 request.signal 直接读放弃时刻，一次运行给出精确点位+后续重试行为
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5a5c87a9-5348-4b9a-8d8d-78766c4bb5f9
  modified: 2026-07-27T22:40:35.751Z
---

要测「客户端对静默的容忍度是多少秒」，**阶梯（试 130s / 180s / 240s…）是错的做法**：每档一次完整运行、成本正比于档数，而且**永远只能夹逼出区间、给不出点位**，也看不到超时之后客户端做了什么。

**正确做法**：服务端静默到**远超**任何可能的容忍度（窗口设 900–1500s），在 handler 里 `await Promise.race([客户端 abort, 窗口耗尽])`，**从 `request.signal` 的 abort 直接读出客户端放弃的毫秒时刻**。一次运行同时给出：精确点位、之后的重试次数与 backoff 序列。

**How to apply:**
- Bun 服务端要 `Bun.serve({ idleTimeout: 0 })`，否则测的是 Bun 不是客户端。
- **两个正样本对照必须先做，否则「没观测到 abort」什么也证明不了**：① `curl --max-time 5` 必须被记成 `abortedAfterMs ≈ 5002`（abort 检测真的工作）；② 一个短窗口必须驱动真客户端走完整成功、且结果里带**服务器自己写的标签文本**（成功路径端到端通，不是形式上跑了一下）。
- 时间基要标清：服务端记的是 **handler 视角**（请求收完解析后起算），客户端超时是 **dispatch 视角**；大 body 会让服务端读数早几百毫秒，所以别声称毫秒级阈值。
- 结束时若是**自己杀掉服务器**，那条末尾错误是清理产物**不是客户端的自然终态**；重试上限没测到就写「未测定」，别写「≥N 次」当结论。
- 每个臂的输出文件名要**按臂派生**，共享默认 label 会让后跑的臂覆盖前一臂的证据。

实例（真 Claude Code pre-header 容忍度）：`exp/silence-recovery-gates/run-q1-firstfail.sh` + `q1-abort-observer-server.ts`，结论见同目录 `FINDINGS.md` §「Q1 续测」。

Related: [[methodology-timeout-attribution-strip-layers-not-config]]（测出点位之后怎么定位是哪一层）、[[feedback-pass-null-clean-not-self-validating]]

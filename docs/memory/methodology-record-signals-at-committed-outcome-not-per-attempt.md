---
name: methodology-record-signals-at-committed-outcome-not-per-attempt
description: buffered-retry 中 per-attempt 重跑的信号/遥测必须在 committed settle 点记录、onAttemptReset 清空累积，绝不 eager per-attempt 记录
metadata:
  type: project
---

L2 buffered-retry（`protect_streaming_generation`）会让 **S5 响应处理（decode rewrite 等）逐 attempt 重跑**——driver 每尝试 re-instantiate S5 chain（`handler-v4.ts` onAttemptReset 区注释自陈"re-instantiates its own S5 chain state per attempt"）。任何在 S5 闭包内**eager 记录**的 per-request 信号/遥测/feature tag，都会被**被丢弃的尝试**污染：

- **set-once 标志被丢弃尝试污染**（malformed tool-input repair 的 audit C1）：attempt 1 畸形块到 `content_block_stop` 触发 `onDecodeFailure` 置 ctx 标志、随后截断 → buffer 丢弃重试；attempt 2 干净却因**标志只挂不清**被判 FAIL + 在合法内容后补 error 帧。set-once（`??=` 从不清空）放大了"信号不丢"为"信号永不清"的 bug。
- **计数器被 retry 次数膨胀**（audit H1）：闭包内 per-attempt `recordToolInputRepair` → N 次重试记 N 次。

**正解（镜像 `protect-streaming-stats` 的 `onBufferedResolve` commit-时记录）**：
1. 信号改 **per-attempt 累积**（`ctx.repairOutcomes` 数组），`onAttemptReset` 清空之。
2. handler 在 **committed settle 点**一次性 flush（`flushToolInputRepairObservability`：遥测 + feature + 日志 + 派生 fail-gate）。flush **不清** outcomes（complete-分支随后还要读派生 `unrepairableToolInput` 做 fail 判定，ctx 本就 per-request 用完即弃）。
3. 派生量（如 `unrepairableToolInput`）从 committed 累积现算，不再独立 set-once。

判据：信号产生在"会逐 attempt 重跑的处理层"、消费在"committed 之后"→ 必须 per-attempt 累积 + commit-flush。注意 spec 把"挂 ctx 非 acc 故 buffered-retry 不丢"当目标本身是不完整的——**不丢 ≠ 不清**，discarded 尝试的信号必须清。关联 [[methodology-sync-to-async-persistence-refactor-invariants]] 的"过渡态/中间态隔离"思路；发现手法见 skill `empirical-verification`（subagent audit 实测复现裁决）。

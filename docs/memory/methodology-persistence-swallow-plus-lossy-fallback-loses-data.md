---
name: methodology-persistence-swallow-plus-lossy-fallback-loses-data
description: 失败记录没进库别只当"漏记";查 finalize 写路径的 swallow + 有损 fallback(写失败仍 removeInFlight);GHC mid-stream NGHTTP2_CANCEL 非时长墙
metadata:
  type: feedback
---

持久化层最隐蔽的丢数据 = **吞错 + 有损 fallback** 的组合：写函数 `try/catch → warn → 继续`，且失败后仍执行清理（如 `removeInFlight`），于是数据既没上盘、又从内存唯一副本删除 = 彻底蒸发，只剩一句 warn。越大/越该诊断的记录越易触发（blob 大、WAL 争用 `SQLITE_BUSY`），所以丢的恰是最有价值的失败。

**Why**：单点看每个 `catch→warn` 都"无害"（best-effort），但与"失败后仍 removeInFlight/cleanup"叠加就成致命丢失。`copilot-api` 的 `finalizeEntry` 正是如此：`insertCompletedEntry` 抛错吞成 warn 后无条件 `removeInFlight`。证据不在某条具体记录（live WAL churn 下 DB 读不可靠，pass-null），而在**生产日志里反复出现的 `FOREIGN KEY constraint failed` swallow**——增量 stage 写假设 head 已存在却没保证。

**How to apply**：
1. 失败记录查不到时，别停在"它没被记录"——读 finalize/persist 写路径，找 `catch→warn` + 其后的无条件 cleanup。这才是丢失点，不是"忘了记"。
2. 修复形状（已落地，见 `docs/history.md` 持久化韧性）：写守卫 `runHistoryWrite`（分类 transient/permanent + ERROR 非 warn + 计数）；**仅确认写成功后才删内存副本**；transient 保留待重试、permanent 降级 tombstone 保住"失败事实"地板；增量写 head-first 原子化根除 FK 类。
3. 否定性结果（DB 里查不到）不自证——live DB churn 会假装"丢了"。用日志里的 swallow 证据裁决，别靠一次不可靠的 DB 快照。呼应 [[feedback-pass-null-clean-not-self-validating]]、[[feedback_complete_root_cause_fix]]、[[feedback-mine-the-pass-with-warn]]。

**附带 reference（GHC 上游）**：opus 流式 mid-stream `Stream closed with error code NGHTTP2_CANCEL`（`kind=transport-close`、`silence` 仅几十 ms = 流仍在喷数据）是**上游主动 RST**，**非固定时长墙**——同库实证有 287s/266s 请求正常完成。node `ERR_HTTP2_STREAM_ERROR` 只在对端 RST 时 emit；我们自己 `req.close()` 走另一句 `closed before end`。是请求/时刻特异的上游中止，本地超时配置（response_header/stream_idle 均 300s、keepalive 15s）均不相关。诊断手法见 [[empirical-probe-via-history-api]]。

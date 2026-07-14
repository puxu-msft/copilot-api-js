# Kick-off：请求首包/时序埋点实施

## 上下文

实现 [docs/plan/2026-07-14-request-timing-instrumentation.md](./2026-07-14-request-timing-instrumentation.md)（权威 spec [docs/spec/2026-07-14-request-timing-instrumentation.md](../spec/2026-07-14-request-timing-instrumentation.md)，已过 3 轮异模型对抗 review）。

为每个请求捕获 7 个首包/时序权威时刻：**上游 4 刻**（headers/message_start/first_token/last_token，绝对 epoch，存 per-attempt attempts[] blob）+ **客户端 3 刻**（stream_open/first_real/buffer_hold，offset 相对 started_at，存 entry 列）。fleet 分位复用遥测 DDSketch registry，非手搓 SQL。动机：15 分钟超时分析发现上游 TTFT p50~6s vs 客户端可见首包 p50~79s，全部长请求缓冲，且**当前无任何 TTFB 埋点**。

## 承重红线（违反=返工）

1. **两套原点分开**：上游 4 刻存**绝对 epoch**（`*At`）到 attempt；客户端 3 刻存 **offset 相对 started_at**（`*Ms`）到 entry 列。**绝不**让上游 attempt 值相对 entry started_at（retry 后含前序 attempt+backoff，撞数学矛盾）。
2. **`toHistoryAttempts` 是显式 allowlist**：新 attempt 字段忘 copy 即被静默 drop（Task 1.2 是 HIGH-1 承重的另一半，别漏）。
3. **列式接线 8 处**（Task 2.4，对齐 `raw_path` 范式）：schema/wanted/EntryRow/buildHeadRow/META_KEYS/INSERT+bind/deserialize/read。META_KEYS 排除 `timing` 避免列/blob 双写。
4. **遥测 3 点接线**（非单 entry extractor）：`SettledTelemetryInput` 加字段 + sink 投影 + `HISTOGRAMS` 注册；boundaries 顶 ≥400_000ms（TTFT max 356s）；注册进 HISTOGRAMS 会**同时**新增 `/metrics` fixed-bucket family（本 spec 接受）。
5. **命名**：`client_stream_open_ms` 不叫 `client_commit_ms`（非 client ACK）。
6. **谓词轴**：upstream 用 `env.targetEndpoint`、client 用 `clientFormat`；keepalive/ping/message_start 不算内容。
7. **不回填**老行 NULL；**测试隔离**用临时 DB；**绝不杀 4141 主服务器**（测试服务器用非 4141 端口 + PID 精确 kill）。

## 执行方式

subagent-driven（每 task 一 fresh subagent + 两阶段 review）或 inline executing-plans。Phase 0→5 有序：0（类型+primitive）→1（上游捕获+attempts 落盘）→2（客户端捕获+列）→3（遥测）→4（ui-v4）→5（文档+收尾）。Phase 1、2 内部 task 有序，Phase 3 依赖 2，Phase 4 依赖 2+3。

派 subagent 时**显式写裁判轴**：长远正确 + 完整（against-YAGNI / richest-data-flow），reviewer 的「无消费者/可删/已通过」绝对断言须亲自对照代码复核。

## 隔离

建议隔离 worktree（`.worktrees/timing-instrumentation`，独立分支）——涉及 driver/client-sink/history-schema 等高并发文件，避免与并发会话冲突。收尾若动过 deps 须主树补 `bun install`。

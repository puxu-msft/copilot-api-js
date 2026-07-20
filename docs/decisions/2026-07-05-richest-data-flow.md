# ADR: richest-data-flow —— 数据以最丰富的形式流动

- **状态**：Accepted
- **日期**：2026-07-05
- **相关**：CLAUDE.md `richest-data-flow` / `single-source-of-truth-types`、ADR [internal-tool-security-posture](2026-07-05-internal-tool-security-posture.md)（其"缺省全量暴露"即本原则的安全立场投影）、记忆 `feedback-richest-data-flow-store-complete-no-pruning` / `feedback-synthetic-data-must-be-distinguishable-from-real`、[spec/history-http-header-capture.md](../spec/history-http-header-capture.md)、DESIGN.md"活的架构现状"（header 四腿捕获、keepalive synthetic 标记等应用）

## 背景

copilot-api 是一个代理：它在客户端与上游之间转发请求/响应，同时把整个生命周期记录进 History 供运维/诊断。这类系统天然有多个数据消费者——转发给客户端的实时流、写进 SQLite 的历史、console 进展日志、前端 UI（History 页各 section）、诊断探针。

一个反复出现的诱惑是：**生产者替消费者提前做裁剪决策**。典型形态——"这个字段前端没展示，就别存了""这条腿和另一条腿字节相同，是冗余，删掉""按 DRY/YAGNI，无消费者的数据模型该砍"。这些论断把"某个当下消费者不需要"错误地推广成"该数据不该存在"，一旦落地就造成不可逆的数据丢失：历史里永远缺了那一段，事后无法重建。

设计 History HTTP header 捕获时正是踩了这个坑（v1–v5 用"无 UI 消费者""与另一腿字节相同""冗余双写"为由裁剪数据模型，砍 per-attempt headers、提议删 `httpHeaders.inboundResponse` 第四腿），经 operator 纠正后 v6 逆转为完整四腿模型。默认持 DRY/YAGNI 的 subagent reviewer 会系统性地把"无消费者"读成"该删"，因此本原则必须显式成文、可引用，作为对抗该默认价值观的裁判轴。

对称地，还有一个更隐蔽的盲区：**往真实数据流里注入的合成帧（keepalive/占位/mock/降级 error）若与真实数据字节无法区分，会把异常通信状态伪装成正常**。把 keepalive 从自明的 `event: ping` 改成空 `content_block_delta`（为绕过 CC 的 300s no-real-content idle 上限）——功能对了，但空 content_delta 在 forwarded 轨伪装成真实内容帧：一条"上游其实沉默、只有心跳"的请求，在 history/UI 里看起来像正常 streaming，运维看不出真相。这是"功能正确 ≠ 可观测性正确"的典型。

## 定夺

**数据以最丰富的形式流动，使用决策交给末端消费者。生产者产出一次完整数据，各消费者按需自取；后端存储必须完整，前端展示可选择性呈现。**

### 1. 生产者不做消费者的决策

handler/producer 只发一次**完整**数据，消费者各取所需。生产者不得因"某个消费者不需要 X"而不产出 X。统一数据源、多端消费：同一份最丰富的数据供实时转发、History、日志、UI、探针共同消费，而非为每个消费者裁一份定制的窄数据。

### 2. 后端完整存储，前端选择性展示（数据模型不可裁剪）

History 记录请求/响应生命周期**所有可观测原始数据**（headers/payload/timing），每个阶段、每个 attempt 自然记录其完整字段，后端**全存、存原始未脱敏**。

- **永不为 DRY / YAGNI / 无消费者裁剪数据模型。** reviewer（默认 YAGNI）说"无消费者→删/砍"时，对**数据模型**一律拒绝。前端选择性展示 ≠ 后端可不存。
- 可以做的是**捕获机制（HOW）的收敛**——一个字段多个写入者→单一干净 owner（这是 single-source-of-truth 的写路径，不是删数据）；不可做的是**数据模型（WHAT）的裁剪**。
- **"无数据源"常是没接线，不是真无源。** 一个真实的生命周期阶段字段若当前没有 producer，应去**建**数据源接线，而不是**删**字段（该建而非该删）。

### 3. 合成数据必须可辨识（对称面）

任何往真实数据流注入合成帧（keepalive / 占位 block / mock 上游 / 降级 error 帧）时，先问：**下游消费者（history / log / UI / diff / 运维）能否区分合成 vs 真实？** 三原则：

- **原始/上游轨绝不含合成物**，始终忠实反映上游真实通信（上游沉默 = 那段轨没有帧，可核对）。
- **合成物只进 forwarded/派生轨，且打显式标记**（如 `SseEventRecord.synthetic` 字段，所有注入点全打，含 ping）。
- **下游据标记区分显示**（如 badge "13 events · 11 keepalive" 一眼看出上游只发 2 个真实帧、心跳行 dim + 标签）。

改动横切数据的形态时（如 keepalive 帧类型 `ping → content_delta`），**必须评估所有下游消费者，不只客户端**——看似只影响客户端，实则可能污染 forwarded 轨的可辨识性。

## 应用实例

- **HTTP header 四腿捕获**（`inboundRequest` / `outboundRequest` / `outboundResponse` / `inboundResponse` + `outboundResponseTrailers`）：每腿 per-attempt 完整存原始未脱敏，顶层镜像最终 attempt。前端可选择性展示，后端不裁剪。见 [spec/history-http-header-capture.md](../spec/history-http-header-capture.md)、DESIGN.md。
- **keepalive synthetic 标记**：所有 keepalive（含 ping）在 forwarded 轨（`inboundResponse.sseEvents`）打 `SseEventRecord.synthetic:"keepalive"`；上游轨 `sseEvents`/`outboundResponse` 绝不含 keepalive；console `bytesIn/eventsIn` 只算上游帧。见 DESIGN.md `streamKeepaliveMode`。
- **client-facing 输出塑造不碰持久化**：`mapHttpErrorToEnvelope` 对 HTML 错误页/空 body 塑造 client 文案，但 **History 始终保留原始上游 body**。见 DESIGN.md `error/`。
- **attribution 剥离仅作用于 wire/effective**：`stripAttributionBillingLine` 剥 wire 请求，但 history `inboundRequest.system[0]` 保留客户端原始 billing 行。见 DESIGN.md `stripAttributionHeader`。

## 备选方案（未采纳）

- **按当前消费者裁剪存储（DRY/YAGNI 派）**：只存前端会展示的字段。——造成不可逆数据丢失，事后无法重建历史；把"当下无消费者"错误外推为"永远不需要"。
- **为每个消费者定制窄数据源**：转发一份、存一份不同的、日志再一份。——多数据源易漂移、须多处同步，违背统一数据源；且仍会在某处提前裁剪。
- **合成帧与真实数据同形**（如空 content_delta 不打标记）：更省一个字段。——把上游沉默伪装成正常 streaming，污染可观测性，是欺骗性假内容。

## 后果

- **正向**：数据以最丰富形式流动，任何事后诊断都有完整原始数据可查；单一数据源多端消费，无漂移；合成 vs 真实全程可辨识，可观测性忠实。遇到"要不要为 DRY/无消费者裁剪"的决策有明确、可引用的立场，不必反复权衡，也用于对抗 subagent 的 YAGNI 默认。
- **代价/边界**：后端存储体量更大（由 zstd blob 压缩 + reaper 分桶消化，见 history-sqlite-schema）。本原则约束的是**数据模型（WHAT）不可裁剪**，不妨碍**捕获机制（HOW）的收敛**（单一 owner、去重写路径仍鼓励）。与 [internal-tool-security-posture](2026-07-05-internal-tool-security-posture.md) 一致：默认全量暴露，除非用户明确要求收敛。

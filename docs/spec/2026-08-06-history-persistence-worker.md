# Spec：History 持久化专用 Worker 与渐进式线程隔离

- **状态：已确认设计，待实施计划。** 用户已确认单个专用 Worker、写入先行、运行中自动重启重放、有界 operation 队列、默认容量 256、请求级背压、startup hard gate 与渐进式验收。
- **日期：** 2026-08-06
- **归属：** `docs/spec/`
- **相关文档：** [History V3 schema](../history-v3-schema.md)、[生命周期](../lifecycle.md)、[结构化诊断 per-process ADR](../decisions/2026-07-17-structured-diagnostics-per-process.md)
- **价值轴：** 模型请求响应性、History 完整性、可恢复性、可观测性、渐进交付。迁移复杂度不是否决长期正确架构的理由。

## 0. 结论

History 使用**一个专用 Bun Worker 线程**。该 Worker 拥有独立 OS 线程和独立 event loop；它不是主线程上的另一组 Promise，也不是多个并行 SQLite writer。

迁移分两大阶段：

1. **写入先行：** semantic terminal persistence、raw capture、summary backfill、checkpoint、incremental vacuum、optimize 全部迁入 Worker。主线程暂留独立只读 SQLite connection。
2. **读取迁移：** detail、list、session、stats 改为 Worker RPC；删除主线程 History SQLite connection。Worker 最终独占 semantic/raw SQLite。

每个阶段继续拆成可独立运行、验证、提交并合入 `master` 的渐进批次。用户明确允许先合入**未接生产主流程但内部自洽的可执行死代码**；不允许合入 aspirational API、不可运行占位壳或没有退出计划的永久双轨。

## 1. 问题

### 1.1 “异步”仍在代理 event loop 上

当前 terminal persistence 使用内存 `pending` 数组和 async `runDrain()`。调用方不等待落盘结果才返回模型响应，但以下工作仍在 Bun 主线程执行：

- `prepareModelOperation()`；
- canonical JSON、hash 与压缩；
- journal append；
- semantic SQLite transaction；
- retry 与 `busy_timeout`；
- summary backfill；
- checkpoint、incremental vacuum、optimize。

`await Promise.resolve()` 和 `setTimeout(0)` 只提供协作式让出，不能隔离同步 SQLite、JSON 或 CPU 工作。一次同步块仍会冻结模型请求、liveness 和所有管理端点。

### 1.2 Raw capture 当前逐帧同步落盘

`src/lib/context/request.ts` 的 frame capture 当前在请求路径直接调用 raw manager：

1. 序列化 frame；
2. SHA-256；
3. 查 `raw_objects`；
4. 解压 collision check；
5. 压缩并写对象；
6. 写 `raw_refs`。

这条路径比 terminal drain 更直接地位于流式关键路径。只迁 semantic writer、不迁 raw capture，不满足“History 落盘退出关键路径”。

### 1.3 运行实证

2026-08-06 对运行中 4141 只读诊断观察到：

- 旧 History artifact 为约 19.5 GB，含约 71,600 个 operation；
- summary migration 期间，主线程 RSS 曾达到约 4 GB；
- 主线程进入磁盘等待时，History list 超过 20 秒且其他端点一起排队；
- 一次 Bun `SIGILL` 有内核证据，其余 PID 变化由用户手动 `Ctrl+C` 重启以加载新代码，不归类为重复 crash；
- `77cc765f` 与 `fa2bfd2d` 已先后止血 readiness 全表重复扫描并改用 keyset backfill；
- 新库上 History list 仍可出现约 0.4 秒延迟，说明“写入 backfill 修复”不等于“所有 History 工作已退出主线程”。

这些数字只描述 2026-08-06 本机对应 artifact 与进程，不是永久性能阈值。

## 2. 冻结决策

| 决策 | 结果 |
|---|---|
| 执行单元 | 一个专用 History Worker 线程；不使用 worker pool |
| event loop | Worker 自有 event loop；主线程不执行 History 写入工作 |
| 迁移顺序 | 写入先行，随后迁读取 |
| 队列 | 有界，按 operation 条数计容 |
| 默认容量 | `256`，可配置 |
| 达峰行为 | 新模型 operation 在模型管线入口等待容量；不丢 History |
| 等待超时 | 无独立代理超时；沿客户端取消与 shutdown signal |
| worker crash | 自动重启，按原序重放所有未终态 ACK 项 |
| startup failure | migration／journal recovery 未成功则不监听代理端口 |
| shutdown | 已准入请求继续；持久化 drain 是 durability barrier |
| dead code | 允许内部自洽、可执行、已测试、后续接线明确的死代码先合主树 |

## 3. 架构

### 3.1 主线程组件

#### `HistoryPersistenceRuntime`

生产实现封装 Worker 与消息协议；测试可注入 in-process backend。调用方只依赖端口，不 import Worker、`bun:sqlite` 或具体 store。

接口必须覆盖以下职责；具体文件与方法拆分由实施计划确定，但不得删减这些职责：

- `start(config): Promise<ReadyStatus>`；
- `enqueue(envelope): messageId`；
- `updateConfig(revision, config): Promise<RawTargetDescriptor>`；
- `stopMaintenance(): Promise<void>`；
- `drain(): Promise<DrainResult>`；
- `shutdown(): Promise<void>`；
- 状态订阅与 worker generation 观测。

`enqueue()` 只做内存登记和 `postMessage`。它不压缩、不触碰 SQLite、不等待 persistence ACK。

#### `HistoryAdmissionController`

管理 operation reservation、FIFO waiter 与容量热调。核心不变量：

```text
0 <= unacked <= reserved
admissionOpen = reserved < capacity
```

正常稳态下 `reserved <= capacity`。配置热调小时不撤销既有 reservation，因此允许短暂 `reserved > capacity`；此时系统进入显式 over-capacity 状态，在 `reserved < capacity` 前不再放行 waiter。不能把 `reserved <= capacity` 写成无条件断言，否则合法热调会被误判为状态损坏。

其中：

- `reserved`：已经准入、尚未收到 persistence 终态 ACK 的 operation；包含在途和 terminal-unacked。
- `unacked`：已经形成 envelope 并发送 Worker、尚未收到终态 ACK 的子集。
- `waitingRequests`：尚未获得 reservation 的 operation。

#### Main-thread overlay

`in-flight` 与 recent terminal overlay 留在主线程：

- in-flight 支撑 live lane；
- recent terminal 让刚完成但尚未持久化的 operation 立即可见；
- Worker ACK 更新 recent durability；
- 持久层读取结果在末端与 overlay 去重合并。

### 3.2 Worker 组件

单 Worker 依次拥有：

- semantic V3 write connection；
- raw store generations；
- terminal prepare／hash／压缩；
- journal 与 semantic transaction；
- transient retry；
- summary backfill；
- checkpoint、incremental vacuum、optimize；
- startup migration 与 journal recovery；
- 第二阶段加入全部 History query RPC。

SQLite 写入保持单写者。不得用多个 Worker 并行写同一 artifact。

### 3.3 第一阶段双连接

写入先行阶段允许：

- Worker：semantic write connection；
- 主线程：独立 readonly connection。

主线程 readonly opener 只能执行 read-safe PRAGMA 与 owner check，不能 schema reconcile、migration、ANALYZE、VACUUM 或任何 DDL／DML。

第二阶段删除主线程 readonly connection。双连接是有明确结束批次的过渡态，不是长期架构。

## 4. Operation reservation 与有界背压

### 4.1 Reservation 生命周期

1. 模型 operation 在上游 dispatch 前调用 `acquire(signal)`。
2. `reserved < capacity` 时立即返回 reservation。
3. 达峰后 operation 进入 FIFO waiter；不占 reservation。
4. 客户端 abort 或 shutdown signal 取消 waiter。
5. reservation 覆盖 operation 全生命周期。
6. terminal 时，reservation 转为 unacked item；`reserved` 不增加。
7. Worker 返回 `persisted | conflict | failed` 终态 ACK 后释放 reservation。
8. 在确定不会产生 terminal record 的创建前失败路径显式 release。
9. Worker crash 不释放 reservation；未 ACK envelope 在新 generation ready 后重放。

背压必须发生在 terminal 前。terminal 产生后才检查队列容量会让请求已经消耗上游资源，却无法可靠记录结局。

### 4.2 入口覆盖

每个会产生 History operation 的入口都必须取得 reservation：

- OpenAI Chat Completions；
- OpenAI Responses HTTP；
- Responses WebSocket 的每个 response operation；
- Anthropic Messages 与 count_tokens；
- Gemini generateContent、streamGenerateContent 与相关 operation；
- embeddings；
- Azure deployment 兼容入口；
- 其他未来产生 terminal History record 的模型入口。

以下表面不受 History admission gate 阻塞：

- `/health/liveness`、`/health`；
- `/api/status`、`/metrics`；
- History 查询；
- config、token、models 等管理 API；
- dry-run pipeline；
- OpenAPI 与 unknown endpoint。

不能把 gate 无条件放进 `createRequestContext()`，因为 dry-run 等非生产路径也创建 context。HTTP 模型 route 和 WebSocket operation driver 必须通过显式 admission wrapper 取得 reservation，再传给 context／operation owner。

### 4.3 容量配置

```yaml
history:
  persistence_queue_capacity: 256
```

约束：

- 正整数；
- 不提供“0 = 无限”；
- 调大后立即按 FIFO 唤醒 waiter；
- 调小时保留已有 reservation，在 `reserved < newCapacity` 前不放新 operation；
- 配置值影响未来准入，不改变已取得 reservation 的 operation。

用户明确选择只按条数背压。单个超大 operation 仍可能造成较大 structured-clone 与 envelope 内存峰值，这是已接受限制。系统仍观测 estimated queued bytes，但它不参与 admission 判定。

### 4.4 等待计时

History admission wait 独立记录为 `historyAdmissionWaitMs`，不能混入现有上游 rate-limit `queueWaitMs`。

等待没有独立代理超时，只由以下事件结束：

- 容量释放；
- 客户端取消；
- shutdown 停止新准入。

## 5. Persistence envelope 与 raw capture

### 5.1 `HistoryOperationEnvelope`

一个 envelope 至少包含：

- protocol version；
- message ID；
- immutable canonical terminal `ModelOperationRecord`；
- operation identity；
- raw capture target descriptor；
- operation 内按 sequence 排序的 raw capture commands；
- Worker 执行所需但不应读取 live config 的冻结值。

Envelope 必须可被 structured clone。生产协议不传函数、class instance、live SQLite handle、AbortSignal 或不可克隆对象。

### 5.2 Raw capture command

request context 每帧只构造内存 command：

- raw frame fields bytes 或可确定生成 bytes 的纯数据；
- sequence；
- track；
- kind；
- capability／gap 输入。

request context 不执行：

- hash；
- compression；
- raw object lookup；
- collision decompression；
- raw SQLite write。

terminal 时 raw commands 与 semantic record 一次投递 Worker。

### 5.3 Raw target 冻结

主线程为每次 raw config 变更分配单调 `configRevision`。`updateConfig(revision, config)` 只有在 Worker 打开／验证目标 artifact 并返回同 revision 的 `config-applied` 后才 resolve。ACK 携可克隆的 raw target descriptor：

- config revision；
- requested；
- db path；
- 持久化 store ID；
- max object bytes；
- 可选 worker-local generation token。

`dbPath + storeId` 是跨 Worker restart 稳定的 artifact identity。worker-local generation token 只用于同一 Worker 生命周期内区分 active／retiring handles；它每次 reopen 可变化，不写入旧 envelope 的跨 restart 校验条件，也不得被描述成持久 generation identity。

主线程维护 `latestDesiredRevision`、`publishedRevision` 与一个代表“latest desired 已发布”的共享 publication barrier。runtime 可串行发送 A、B 等 config revision，但中间 revision A 的 `config-applied` 只更新 A 对应 update waiter／诊断状态；若此时 `latestDesiredRevision=B`，A ACK **不得**发布 admission descriptor、不得 resolve admission barrier、不得放行模型请求。只有 ACK revision 同时满足 `revision === latestDesiredRevision`，runtime 才先原子设置 `publishedRevision=revision` 与 active descriptor，再 resolve barrier。连续新 revision 到达时，必须在任何旧 barrier continuation 获得调度前，先同步更新 `latestDesiredRevision` 并保持／替换为仍 pending 的 barrier；因此 A→B 之间不存在 admission 窗口。迟到旧 revision ACK 只计数，不得回退 active descriptor。

Worker restart 的 `initialize` 携主线程 `latestDesiredRevision`。`ready` 必须回显该 revision 及已验证 descriptor；revision 不匹配则不进入 ready、不重放。匹配的 `ready` 与 latest `config-applied` 走同一个原子发布原语，并 resolve crash 前仍 pending 的 publication barrier。`fatal` 必须 reject barrier 与所有 config update waiter。restart 前已经取得 reservation、并按旧 published descriptor 准入的 operation 仍写入冻结 target；尚未取得 reservation 的请求继续等待 barrier。Worker 收到旧 target envelope 时可重新打开其 `dbPath`，但只能以持久化 `storeId` 校验 artifact identity；匹配即合法，worker-local generation token 不参与跨 restart 判定。旧 envelope 不能被改写到当前 active descriptor 指向的另一 artifact。

### 5.4 Semantic 与 raw 失败关系

保持现有契约：raw capture 是附加能力。

- raw 成功：写 object／ref；
- raw too-large／failed／identity mismatch：形成显式 gap；
- raw 失败不回滚 semantic V3 terminal commit；
- semantic durability outcome 独立返回。

## 6. Worker 消息协议

所有消息带：

- `protocolVersion`；
- `workerGeneration`；
- 单调 `messageId` 或 request ID。

### 6.1 主线程 → Worker

| 消息 | 作用 |
|---|---|
| `initialize` | DB path、最新 desired config revision、raw 配置、retry 与 maintenance 配置 |
| `persist-operation` | 投递完整 operation envelope |
| `update-config` | 携单调 revision 更新未来 operation 使用的配置 |
| `stop-maintenance` | 停止领取新的 backfill／maintenance unit |
| `drain` | 等待所有已接收 persistence item 取得终态结果 |
| `shutdown` | drain 后关闭 semantic/raw DB |
| 第二阶段 query messages | list/detail/session/stats RPC |

### 6.2 Worker → 主线程

| 消息 | 作用 |
|---|---|
| `ready` | migration、schema、journal recovery 已完成；携最新 config revision 与已验证 raw descriptor |
| `config-applied` | 携 revision 与已验证 raw descriptor，作为主线程原子发布新配置的 ACK |
| `persist-result` | `persisted | conflict | failed` 终态 ACK |
| `status` | Worker／DB 状态增量 |
| `drained` | 指定 barrier 之前的 persistence 已终结 |
| `closed` | DB handles 已关闭 |
| `fatal` | 协议、schema、migration 或 recovery 的不可恢复错误 |

### 6.3 ACK 采信

- 只采信当前 `workerGeneration`；
- 首次 ACK 必须命中已知未 ACK `messageId`；
- runtime 保留有界 completed-ACK tombstone：同 generation、同 `messageId`、同 outcome 的重复 ACK 幂等忽略并计数；同 ID 不同 outcome 触发 fail-fast；
- 不在未 ACK 集或 completed tombstone 中的未知 ACK、版本不匹配或状态机非法跳转触发 fail-fast；
- 旧 generation 的任何 ACK 一律忽略并计数，不与当前 generation 的 message ID 空间混用；
- `failed` ACK 释放 reservation，但留下 sticky durability failure；
- `persisted` 更新 recent durability 并释放 envelope；
- `conflict` 保持当前数据契约错误语义，不重试为另一个 operation。

## 7. Worker crash、重启与重放

### 7.1 主线程是未 ACK 队列 owner

主线程按 `messageId` 保存所有未终态 ACK envelope。`postMessage` 成功不代表 durability，也不释放主线程副本。

Worker crash 时：

1. 标记当前 generation 失效；
2. 保留未 ACK envelope 与 reservation；
3. 使用有上限指数 backoff 启动新 Worker；
4. 新 Worker 完成 migration／journal recovery 并发 `ready`；
5. 主线程按原 `messageId` 顺序重放；
6. 旧 generation 迟到 ACK 不得释放任何新 generation 状态。

运行中 Worker 暂时不可用时，主线程仍可继续准入，直到 `reserved == capacity`；随后新模型 operation 自然背压。liveness 与管理 API 继续工作。

### 7.2 Terminal fatal 状态

Worker 普通 crash／可重试启动错误走自动重启。只有协议不兼容、owner/schema 不可恢复、migration/recovery 明确永久失败等 `fatal` 才把 runtime 原子转入不可逆 `terminal-failed`：

1. 停止 restart timer，拒绝创建新 Worker；
2. 关闭 admission，以具名 History durability error 拒绝所有 admission waiter、config publication barrier 与 config update waiter；
3. 将当前全部未 ACK item 原子终结为 `failed`，逐项更新 recent durability、释放 reservation、释放 envelope；
4. 已获 reservation 但尚未 terminal 的请求继续走现有 graceful drain；它们随后 enqueue 时立即得到 `failed` 并释放各自 reservation。terminal-failed 后不得重新积压；
5. 设置 sticky fatal error，并触发进程现有 graceful shutdown；
6. 已在等待的 `drain()` 立即 reject；后续 `drain()` 同样确定性 reject；
7. shutdown 捕获该 rejection 后进入 `failed` 并 exit 1，不等待永远不会到来的 ACK。

这条转移必须避免双释放：fatal 批量终结与迟到 ACK 通过同一 message state transition 原语竞争，只有首次从 `unacked` 离开的路径能释放 reservation。旧 generation 的迟到 ACK 按 §6.3 忽略。

### 7.3 幂等基础

- semantic：`operation_id + revision + digest` 相同重放为 no-op；不同 digest 是 conflict；
- journal：事务前自包含记录，startup recovery 重建 prepared artifacts；
- raw object：hash 命中后逐字节 collision check；
- raw ref：同 operation／sequence／track 键覆盖为同一最终状态。

### 7.4 不扩大为进程级 exactly-once

本设计保证**Worker crash**后的未 ACK 重放。它不声称解决主进程在以下时刻崩溃的数据丢失：

- active operation 尚未 terminal；
- terminal envelope 仅存在主线程内存，尚未由 Worker 写 journal。

若未来要求跨主进程 crash exactly-once，需要独立 durable ingress log；不能把本轮内存队列描述成该保证。

## 8. Startup 与 shutdown

### 8.1 Startup hard gate

启动顺序：

1. 创建 Worker；
2. Worker 打开 semantic DB；
3. owner check 与 schema reconcile；
4. forward migrations；
5. journal recovery；
6. Worker 按 `initialize.configRevision` 打开／验证 raw config；
7. Worker 发携相同 config revision 与 raw descriptor 的 `ready`；主线程核对 revision 后原子发布 descriptor；
8. 写入先行阶段主线程打开 readonly connection；
9. 代理开始监听。

migration、owner check 或 journal recovery 失败时，不监听代理端口。不能静默降级为无 History 服务。

### 8.2 Graceful shutdown

1. Step 1 关闭新模型 ingress／admission waiter；已获 reservation 的请求继续。
2. 正常 request drain 期间 Worker 保持可用并继续接 terminal envelope。
3. request context finalizer quiesce 后，解除 terminal subscriber并排空 subscriber 投递。
4. 发 `stop-maintenance`；不排空可恢复 backlog，只完成已领取 durable unit。
5. 发 `drain`；等待所有未 ACK persistence item 取得终态 outcome。
6. 任一 durability `failed` 使 shutdown 进入 `failed`、exit 1，不发布成功终态。
7. 发 `shutdown`；Worker 关闭 raw generations 与 semantic DB，回 `closed`。
8. History barrier 成功后继续 Telemetry／Diagnostic barrier。
9. 全部 durability barrier 成功后才发布 `stopped`。

Worker 在 drain 中普通 crash 时仍自动重启、recovery、重放并继续 drain。若 restart 期间收到 `fatal`，runtime 按 §7.2 批量终结未 ACK items 并让 `drain()` 确定性 reject；shutdown 进入 `failed`、exit 1。第二个 SIGINT／SIGTERM 保持现有逃生舱：立即 130／143，不等待 Worker。

## 9. 可观测性

`/api/status` 与 metrics 至少暴露：

- `history_queue_capacity`；
- `history_queue_reserved`；
- `history_queue_unacked`；
- `history_queue_waiting_requests`；
- `history_queue_estimated_bytes`；
- `history_worker_generation`；
- `history_worker_ready`；
- `history_worker_restarts_total`；
- `history_worker_replays_total`；
- `history_worker_consecutive_failures`；
- `history_worker_last_error`；
- `history_worker_terminal_failed`；
- `history_worker_next_retry_at`；
- `history_raw_config_revision`；
- `history_raw_published_revision`；
- `history_queue_oldest_unacked_ms`；
- `historyAdmissionWaitMs` 分布。

状态应能区分：

- Worker 正常、队列空；
- Worker 正常、消费落后；
- Worker 重启中；
- startup hard failure；
- config update 待 ACK／已发布 revision；
- persistence terminal failure；
- runtime terminal-failed；
- shutdown drain 中。

## 10. 运行时实证前提

2026-08-06 使用 Bun 1.3.14 做过最小探针，确认：

- Worker 可直接加载 TypeScript entry；
- `Uint8Array` 和 `Map` 经 structured clone 保真；
- Worker 内 `bun:sqlite` 可建内存库并读写；
- Worker 未捕获异常触发主线程 `worker.onerror`。

该探针只证明 runtime primitive 可用，不证明生产协议、重放、shutdown 或性能隔离。Batch 0 必须把这些能力变成仓库内自动化测试，不能引用临时探针代替验收。

## 11. 渐进式交付与验收

### 11.1 每批通用规则

每个 batch 必须：

- 当前主树可启动、可服务；
- 当前批内部自洽；
- 新路径有真实正样本；
- 旧路径或故障注入有负样本，证明门有判别力；
- 相关 test、typecheck、lint 通过；
- 通过后立即提交并合入 `master`，不等待后续 batch；
- 写清“本批证明什么／不证明什么”；
- 后续 batch 只能替换内部实现，不撤销已验证契约。

### 11.2 允许先合死代码的边界

允许先合主树的未接线代码必须同时满足：

1. 可被测试真实执行，不是类型占位；
2. API 与状态机闭合，无 TODO／TBD 决定；
3. 不改变现有生产行为；
4. 不启动泄漏的 timer、Worker、DB handle 或监听器；
5. 有明确后续接线 batch；
6. architecture／test discovery 能发现它；
7. 失败会使本批测试红，而不是“因为没有消费者所以无影响”。

不允许：

- aspirational import 或不存在的 symbol；
- 永不实例化、也无测试执行的壳；
- 仅返回硬编码成功的 fake production backend；
- 为过测试而与真实 Worker 协议分叉的替身；
- 没有移除批次的永久双轨；
- 用“dead code”掩盖本应在当前批接线的 correctness requirement。

### Batch 0：协议与 Worker runtime 骨架

**交付：**

- protocol types；
- `HistoryPersistenceRuntime` 端口；
- 真 Bun Worker runtime；
- in-process test backend；
- runtime 状态机。

允许不接生产 History。

**验收：**

- 真 Worker ready／request／ACK；
- structured clone 保真；
- Worker 内真 `bun:sqlite`；
- error／terminate 可观测；
- 无 import 副作用和资源泄漏；
- fake 与真 Worker 运行同一组 protocol contract tests。

**不证明：** 生产 History 已离开主线程。

### Batch 1a：Admission controller primitive

**交付：**

- capacity config schema／state；
- FIFO reservation controller；
- abort／shutdown cancellation；
- capacity hot reload；
- status／metrics primitive。

允许尚未接模型 route。

**验收：**

- `0 <= unacked <= reserved` 不变量；
- 正常稳态 `reserved <= capacity`，热调小后的显式 over-capacity 状态与恢复；
- 达峰等待；
- release 严格 FIFO；
- abort 不泄漏；
- 调大／调小语义；
- disabled History 的明确 bypass 契约。

### Batch 1b：Admission 生产接线

**交付：**

- 所有 HTTP 模型入口；
- Responses WebSocket 每 operation；
- reservation 传递、terminal transfer 与 pre-terminal release；
- `historyAdmissionWaitMs`。

terminal persistence 仍可使用旧 writer。

**验收：**

- 逐入口正样本；
- 达峰时模型请求等待；
- liveness／status／History query 不等待；
- architecture guard 冻结入口集合或统一接缝；
- mutation：绕过任一模型入口会使守卫红。

**本批价值：** 在 Worker writer 接线前先建立可靠容量门。

### Batch 2a：Semantic Worker backend（未接生产）

**交付：**

- Worker 内 semantic open／migration／recovery；
- prepare／compress／journal／commit／retry；
- terminal ACK；
- crash restart／replay。

允许 production terminal subscriber 仍调用旧 writer。

**验收：**

- 临时 DB 真写入；
- crash-before-journal；
- crash-mid-transaction；
- crash-after-commit-before-ACK；
- 每种窗口最终一条 operation、正确 outcome；
- old-generation ACK 拒绝；
- restart 后 `ready` 的 config revision 不匹配则拒绝进入 ready／拒绝重放；
- restart recovery `fatal` 将所有未 ACK item 终结为 failed，释放 reservation，`drain()` 确定性 reject；
- fatal 与迟到 ACK 竞态只释放一次；
- startup hard failure。

### Batch 2b：Semantic terminal 生产切换

**交付：**

- terminal subscriber 改投 envelope；
- reservation 由终态 ACK 释放；
- recent durability 接 ACK；
- 删除生产旧 drain 接线。

**验收：**

- 模型响应不等待 persistence ACK；
- Worker 注入 500 ms block，liveness／模型交付不出现对应冻结；
- in-process 负样本观察到冻结；
- response→terminal→ACK 活路径；
- shutdown drain 覆盖未 ACK replay。

**本批完成声明：** semantic terminal 落盘已退出主线程。

### Batch 3a：Raw command accumulator（未接 Worker）

**交付：**

- 纯内存 raw command model；
- request context accumulator；
- raw target descriptor；
- envelope raw 部分。

可以通过 shadow/test 路径执行，不切生产 raw writer。

**验收：**

- frame→command 字节语义；
- sequence／track 顺序；
- config revision 串行，`publishedRevision` 只可推进到 `latestDesiredRevision`；
- A→B 连续热切时，A ACK 不 resolve admission barrier、不发布 A descriptor；
- pending latest revision 存在时所有新 admission 等待共享 publication barrier，不能并发冻结中间 descriptor；
- latest ACK 原子发布后才 resolve barrier 并放行 operation；
- 迟到旧 revision ACK 不回退 descriptor；
- Worker restart `ready` revision／descriptor 对账，并恢复 crash 前 pending barrier；
- 跨 restart 只校验 `dbPath + storeId`，worker-local generation token 变化不误杀合法旧 envelope；
- config fatal reject barrier／update waiter；
- operation target 冻结；
- structured clone；
- 内存 accumulator 无 SQLite／compression import。

### Batch 3b：Raw capture 生产切换

**交付：**

- Worker raw generations；
- hash／collision check／compress／object／ref；
- request context 删除同步 raw manager 调用。

**验收：**

- raw success／gap／too-large／rotation；
- raw failure 不回滚 semantic；
- crash replay 不重、不丢 refs；
- architecture guard 禁止 request path import raw SQLite manager；
- 流式高帧量探针不出现 raw SQLite 主线程阻塞。

### Batch 4a：Backfill Worker backend（未接 timer）

**交付：**

- keyset backfill command；
- cooperative stop；
- progress／readiness status。

**验收：**

- 可恢复 keyset；
- poison；
- stop 后不领新 batch；
- restart 继续；
- 大样本 query plan 仍为 index range search。

### Batch 4b：Maintenance 生产切换

**交付：**

- backfill startup 接 Worker；
- checkpoint／incremental vacuum／optimize 接 Worker；
- 删除主线程 production timer。

**验收：**

- 慢 maintenance 时主线程 metronome／liveness 不冻结；
- shutdown 不排空 backlog；
- architecture guard 禁主线程生产调用维护写操作。

### Batch 5：Startup 与 shutdown 全链闭合

**交付：**

- Worker ready hard gate；
- stop-maintenance／drain／close；
- shutdown failure propagation；
- status 完整接线。

**验收：**

- migration／recovery failure 时端口不监听；
- request drain 期间仍可 terminal；
- Worker drain 中普通 crash 后 recovery／replay；
- restart recovery `fatal` → 未 ACK 批量 failed、reservation 释放、drain reject、shutdown failed；
- durability failed → shutdown failed；
- 第二信号立即 130／143；
- 非 4141 端口真进程启动／运行／关闭。

**完成声明：** 写入先行阶段完成。此时仍不宣称 History 查询退出主线程。

### Batch 6a：Query RPC backend（未接 HTTP）

**交付：**

- detail／summary page／session／stats protocol；
- query cancellation／error；
- Worker query implementation。

允许 HTTP 仍读主线程 readonly DB。

**验收：**

- RPC 结果与当前 query functions 对真实 fixture 等价；
- cursor／方向／filter／错误矩阵；
- query 与写 ACK 次序语义明确；
- cancellation 不终止 Worker。

### Batch 6b：History HTTP 读取切换

**交付：**

- History handlers await query RPC；
- 主线程末端合并 in-flight／recent overlay；
- 删除主线程 readonly connection。

**验收：**

- API byte／分页／cursor／错误行为；
- query Worker 故意阻塞时模型路径与 liveness 不冻结；
- architecture guard 禁主线程 import History SQLite driver／connection／raw manager；
- 生产 runtime 只有 Worker 打开 semantic/raw DB。

**最终完成声明：** History 的 SQLite、压缩、查询与维护全部退出代理主线程。

## 12. 测试矩阵

### 12.1 Protocol contract

同一组 contract tests 必须运行于：

- 真 Bun Worker；
- in-process test backend。

fake 不得比真 Worker 更友好：错误码、unknown ACK、crash、close、outcome 必须对齐。

### 12.2 线程隔离正负对照

正样本：

- Worker 注入确定性 500 ms 同步 block；
- 同时驱动 liveness 和主线程 metronome；
- 不出现约 500 ms 对应冻结；
- 模型响应交付不等待 ACK。

负样本：

- 同一 harness 切 in-process backend；
- 注入同样 500 ms block；
- liveness 或 metronome 必须观察到约 500 ms 冻结。

负样本不红则该验收门无判别力。

### 12.3 Backpressure

- capacity=1，两 operation 并发；
- 第一条持 reservation；第二条 pending；
- ACK 第一条后第二条获准；
- abort 第二条不泄漏；
- management API 同期可访问；
- WebSocket 多 response operation 独立计容。

### 12.4 Crash windows

至少覆盖：

- 收到 envelope 前 crash；
- journal 后、transaction 前 crash；
- transaction 中 crash；
- commit 后、ACK 前 crash；
- drain 中普通 crash；
- repeated crash backoff；
- restart migration／recovery fatal；
- fatal 与迟到 ACK 竞态；
- stale generation ACK；
- raw config ACK 前／后并发 admission；
- A、B 连续 revision 中 A ACK 与 admission continuation 交错，只有 B ACK 放行；
- B 到达时同步安装／保持 latest publication barrier，不出现 A→B 空窗；
- config update pending 时 Worker crash，matching ready 恢复 publication barrier；
- config fatal reject barrier；
- restart ready revision mismatch；
- 同一 `dbPath + storeId` 重开后 worker-local token 改变，旧 envelope 仍合法；
- 相同 path 但 store ID 不同必须形成 identity failure／raw gap。

### 12.5 Shutdown

精确断言：

1. stop new admission；
2. accepted request terminal；
3. subscriber drain；
4. stop maintenance；
5. Worker persistence drain；
6. DB close；
7. History barrier；
8. Telemetry／Diagnostic barrier；
9. publish stopped。

## 13. 不采纳方案

### 13.1 主线程内单独 async loop

不采纳。它没有独立 event loop，SQLite／JSON／compression 同步块仍冻结代理。

### 13.2 多 Worker writer pool

不采纳。SQLite 写入串行，pool 增加锁竞争、排序、ACK 与 transaction ownership 复杂度。

### 13.3 独立进程＋UDS

当前不采纳。隔离更强，但 supervision、IPC、部署和查询 RPC 成本高于单 Worker。若未来需要跨进程 durability、独立扩缩或多 serving process 共享 writer，再单独决策。

### 13.4 无界队列

用户在设计讨论中明确改为有界 operation 队列。无界队列会让 Worker 长时间落后时主线程内存无上限增长。

### 13.5 Worker crash 后释放队列

不采纳。`postMessage` 不等于 durability；释放未 ACK envelope 会静默丢记录。

### 13.6 startup 降级为无 History

不采纳。migration／journal recovery 是 hard gate；未知持久化状态不能静默服务。

## 14. 已知限制与后续边界

- 只按 operation 条数背压，不限制单 operation 字节峰值；
- Worker crash 可重放，主进程 crash 前的内存 envelope 不具跨进程 durability；
- 写入先行阶段仍有主线程 readonly SQLite，History query 仍可能阻塞 event loop；
- structured clone 在 ACK 前造成主线程 envelope 与 Worker clone 双份驻留；
- Worker restart backoff 期间已准入 operation 可继续累积到 capacity；
- 第二阶段前不能声称“History 全部退出主线程”。

这些限制必须出现在每批交付报告，不得被“Worker 已接入”一句话掩盖。

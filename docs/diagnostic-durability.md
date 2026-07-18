# 结构化诊断文件持久化

本文是 diagnostic file subsystem 的**当前实现契约**。冻结设计动机见 [RFC](rfc/2026-07-17-tui-structured-logging.md) §7.2/§7.4；进程级关闭顺序见 [lifecycle.md](lifecycle.md)；事故与工作流复盘见 [2026-07-18 audit](audits/2026-07-18-diagnostic-durability-retrospective.md)。

## 模块边界

| 模块 | 唯一职责 | 不应拥有 |
|---|---|---|
| `CountingDestination` | `accepted/settled/queued/written/dropped` 字节记账、dirty paths、sticky destination failure | flush 策略、fsync、shutdown 状态机 |
| `DurableFileWriter` | generation checkpoint、strict progress、checkpoint 串行、roll namespace 稳定、file+directory fsync、marker、end/close | Pino record、bus、file threshold |
| `StructuredFileSink` | record union、Pino serialization、file threshold、串行 maintenance | backend flush/fsync 协议 |
| `BootstrapDiagnosticSpool` | 全会话 WAL、WAL-first mirror、delivery identity、orphan claim、corrupt isolation | 长期 NDJSON rotation |
| `diagnostics/file/index.ts` | generation-keyed attach/disable/shutdown lifecycle queue、生产 active owner | backend 内部状态 |

`tests/diagnostics/module-boundaries.unit.test.ts` 是 L1 架构守卫：`StructuredFileSink` 不得重新出现 backend flush、end、fsync 或 dirty-path 协调；全会话 WAL 必须继续作为生产 file-bus owner。

## 正常数据流

```mermaid
flowchart LR
  B[Observability bus] --> W[BootstrapDiagnosticSpool]
  W -->|完整 WAL write + delivery identity| M[mirror]
  M --> S[StructuredFileSink]
  S --> P[Pino / pino-roll]
  P --> D[per-process NDJSON segments]
```

Spool 是全会话唯一 file-bus owner，不是 writer ready 前的短生命周期 buffer。每条 live record 先完整写 WAL，再以同一个 `(spoolId, sequence, digest)` mirror 到 sink。Digest 对不含 `delivery` 的完整 payload 计算；长期 NDJSON 只有 record 结构完整且重算 digest 匹配时，才能证明该 delivery 已 committed。

File logging 被禁用时，spool seal/fsync 后删除，不创建长期 sink。

`disableStructuredFileLogging()` 与 attach/shutdown 共用 lifecycle queue，但它不是 shutdown completion barrier，也不单独开启 generation；它只把当前 file producer seal 后删除。`shutdownStructuredFileSink()` 才按 writable generation 缓存并共享 terminal barrier；一个 attach 调用在入队前开启下一 writable generation，所以紧随其后的 shutdown 必须排在该 attach 后收敛新 owner。

## Checkpoint 与 shutdown

一次 `DurableFileWriter.durable()` 同步冻结调用时的 cumulative `acceptedBytes` 为 generation target。调用后到达的 producer 属下一 generation。Writer 重复触发 backend flush，要求 `settledBytes = writtenBytes + droppedBytes` 对 target 严格前进；无进展立即失败，禁止无限等待。

Target settle 后：

1. 让出事件循环并采样 active path 与 segment namespace。
2. fsync 本 generation 的 dirty paths 和所有匹配的 regular segments。
3. fsync 父目录。
4. 再次采样 path/namespace；发生 roll 则重做，最多 8 次，不稳定即失败。

Clean shutdown 顺序：

1. Spool `retireDurably()`：停止 bus ingress，fsync WAL。
2. Sink 普通 generation durable。
3. 写唯一 `shutdown_diagnostic_sealing` marker。
4. Marker generation durable。
5. Destination `end()` exactly once，并等待 close/error。
6. 只有 sink barrier 成功，才删除所有 WAL artifacts并 fsync父目录。

Drop、同步 write throw、异步 error、短写零进展、fsync、roll 不稳定、marker drop 和 maintenance failure 都是 sticky failure。失败路径仍 best-effort end/close，但不得进入 shutdown 成功 latch。

## Crash recovery

启动时只恢复 owner 确定死亡的 spool。V2 名称包含 pid 与 Linux proc start ticks，避免 PID reuse；恢复前用 atomic rename claim，后续 claimant 替换旧 claim owner 后缀，允许连续崩溃。

Replay 是两次独立流式遍历：

1. 第一遍收集当前 WAL 的 wanted delivery identities。
2. 长期 scanner 只保留 wanted 且 payload digest 验证通过的 committed 命中。
3. 第二遍逐条 replay 未提交 records；不物化全部 WAL records。

WAL 存活期间 runtime segment prune 禁用，避免 WAL 删除前 committed ledger 消失。JSON 语法损坏、digest mismatch 或 JSON-valid 语义损坏均隔离到 `.corrupt-*`；合法前缀继续恢复，损坏 artifact 保留取证且不永久 wedge 启动。

## 第三方边界

当前 lockfile 解析到 SonicBoom 4.2.1；它在 active write 后排入 `<minLength` tail 时，第一次 `flush(callback)` 可能在 tail 尚未写出时返回。项目不读取 `_len` 等私有字段，以 `CountingDestination` cumulative counters 为 completion oracle。依赖升级时以 backend contract probe 重新裁决，不把 4.2.1 当永久 pin。

`pino-roll` 的数值 `size` 单位是 MiB，而项目配置是 bytes；adapter 必须传 `${bytes}b`。Pino logger 固定 `level: "trace"`，业务 file threshold 只由 `StructuredFileSink.writeRecord()` 裁决，确保 direct bus、WAL replay 和 live mirror 一致。

## 测试真相域

| 层 | 证明什么 | 入口 |
|---|---|---|
| Backend contract | Bun/Node 真 SonicBoom callback 与项目 writer 行为 | `backend-flush-contract.it.test.ts`、`durable-writer-runtime.it.test.ts` |
| Primitive | generation、progress、failure、fsync、roll、marker、close | `counting-destination.unit.test.ts`、`durable-writer.unit.test.ts` |
| Sink | Pino level、record union、threshold、权限、drop | `structured-file-sink.it.test.ts` |
| Production seam | WAL、digest、claim、corrupt、failure/retry、generation、rotation | `bootstrap-spool.it.test.ts`、`shutdown-barrier.it.test.ts`、`multiprocess-rotation.it.test.ts`、`segment-files.it.test.ts` |
| Process | 真 SIGINT exit code、artifact、raw/cooked terminal | `tests/shutdown/shutdown-signals.it.test.ts` |

通用正样本、测试分层和 exactly-once 纪律归 [coding-conventions.md](coding-conventions.md)「测试组织」节；本文只维护本域的真相矩阵与入口。

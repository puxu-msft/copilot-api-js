# ADR：Canonical structured diagnostics 与 per-process artifact ownership

- 状态：Accepted / Implemented
- 日期：2026-07-17
- 相关：[TUI 与终端日志审计](../audits/2026-07-17-tui-terminal-logging.md)、[实施 RFC](../rfc/2026-07-17-tui-structured-logging.md)

## 背景

旧系统在 consola reporter 中把未知参数预先字符串化，再把文本同时送终端和共享 `copilot-api.log`。这会让 BigInt/circular/error-like 值反向抛错或丢结构，secret 可能先进入 message/error 后绕过字段 redaction；graceful-restart overlap 的两个进程还会竞争同一个 size-rotation 命名空间并实测丢行。终端方面，stdout、raw stdin、请求 projection、selection 与 DECSTBM 编排集中在同一巨型 class，故障与功能演进边界不清。

## 决策

1. `ObservabilityBus` 是唯一 fan-out 主干；canonical 系统诊断是 `system.diagnostic { diagnostic: DiagnosticEvent }`。入口固定执行 bounded snapshot→recursive redaction→deep freeze→publish。human line 与 NDJSON 都是末端 projection。
2. 新代码使用 immutable scoped `DiagnosticLogger`；consola 仅为存量 compatibility adapter，不再拥有文件或 stdout。
3. Pino/pino-roll 只作为 file-only backend。每个进程拥有独立 base、durable owner manifest 和 segments；不存在 shared active symlink/file。保守 retention 只删除 owner 明确死亡且过期的 regular artifacts。
4. 启动期使用 `0600` bootstrap spool 作为 canonical file WAL；writer ready 后 spool records 只 replay 给 file sink，不回 bus。durable 后 unlink 并 fsync directory。失败保留 spool，绝不回退共享轮转文件。
5. Writer 通过项目拥有的 `CountingDestination` 记录 queued/written/dropped bytes；drop/error 是 sticky durability failure。shutdown 只有在 History、Telemetry、diagnostic 全部 barrier 成功后才发布成功终态；否则发布 `system.shutdown_failed` 且成功 latch 不 resolve。
6. Credential 原文不进入 bus。GitHub token 与 device user code 只能通过 terminal-only `SensitiveOutputPort.writeOnce()` 显示。
7. TUI 内部拆为 `ActiveRequestStore`、ID-based controller、`KeyDecoder`、`TerminalSession`、`TerminalView`、`OutputArbiter` 与纯 render leaves；`TerminalUi` 只编排。stdout 与 stderr 各有独立故障 owner。

## 后果

- 正向：结构化 scope/correlation/error fields 可被终端、NDJSON、未来 OTLP 共同消费；secret 与异常值在单一 canonical 边界治理；进程 overlap 无共享 rename race；shutdown durability 变成真实可失败契约；TUI 可独立扩展 viewport/job control/backpressure。
- 代价：新增 per-process 文件与 manifest，运维读取需按目录聚合；boot spool/retention/durability 状态机比同步 shared append 更复杂；Pino backend 与 Bun job-control 分支都需要双运行时/真 PTY 测试。
- 不采纳：继续修补 shared rotation 锁；让 Pino/LogTape 成为第二个 router；把 structured fields 再拍平成 message；由 logger 接管 stdout；drop 后继续报告 shutdown success。

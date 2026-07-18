---
name: diagnostic-durability
description: 当修改 copilot-api-js 的结构化诊断文件、BootstrapDiagnosticSpool、CountingDestination、DurableFileWriter、pino-roll rotation、diagnostic shutdown barrier、WAL replay/claim/corrupt recovery、或排查 Ctrl+C 停在 History and telemetry barriers completed 时使用——全会话 WAL-first mirror、accepted-generation checkpoint、file+directory fsync、内容寻址 delivery 幂等恢复、generation-keyed lifecycle queue，以及 backend contract→primitive→sink→production seam→PTY 的测试真相域。
---

# Diagnostic durability

## 先定边界

正面职责只在 `docs/diagnostic-durability.md` 的模块边界表维护。本 skill 只列改动红线：

- `StructuredFileSink` 不得拥有 backend flush、fsync、rotation 稳定或 end/close 状态机。
- `CountingDestination` 不得读取 SonicBoom 私有状态或决定 checkpoint 生命周期。
- `BootstrapDiagnosticSpool` 之外不得再建第二个 file-bus owner。
- 生产 attach/disable/shutdown 不得绕过 `diagnostics/file/index.ts` 的 lifecycle queue。

冻结意图看 `docs/rfc/2026-07-17-tui-structured-logging.md` §7.2/§7.4，当前模块/数据流/恢复契约看 `docs/diagnostic-durability.md`，跨子系统关停顺序看 `docs/lifecycle.md`，目录级关系看 `docs/DESIGN.md`，踩坑复盘看 `docs/audits/2026-07-18-diagnostic-durability-retrospective.md`。

## Durability 不变量

完整协议只在 `docs/diagnostic-durability.md` 维护。操作时不得违反三条红线：

1. `StructuredFileSink` 不拥有 backend flush、fsync、roll 稳定或 end/close 状态机。
2. 不读取 SonicBoom 私有字段；checkpoint 只以项目公开 cumulative counters 和稳定 namespace 为真相。
3. 第三方 callback、size、level、rotation 或 runtime 行为变化，必须先更新 backend contract probe，再修改 adapter。

## WAL 与恢复不变量

完整 WAL 数据流、delivery identity、两次流式遍历、claim、corrupt isolation 与 clean shutdown 删除条件见 `docs/diagnostic-durability.md`。修改恢复协议前必须先写 crash-before-commit、crash-after-commit、retry、claimant-crash、syntax/semantic corruption 和 shutdown×attach failure matrix。

## Lifecycle 不变量

- attach、disable、shutdown 全部经过同一 lifecycle queue。
- Attach 调用入队前开启 writable generation；`shutdownBarriers` 按 generation key，两个同 generation caller 共享同一 promise，queued attach 后的 shutdown 必须获得新 barrier。
- Bus failure 与 stopped 真值归 `process-lifecycle-shutdown` / `docs/lifecycle.md`；本 skill 只要求 production diagnostic facade 的 attach/disable/shutdown 接线必须有真实 integration oracle。

## 测试真相域

分层矩阵及具体入口只在 `docs/diagnostic-durability.md` 维护；通用正样本与 exactly-once 纪律归 `docs/coding-conventions.md`。额外要求：`tests/diagnostics/module-boundaries.unit.test.ts` 必须保持绿色。

## 修改后的验证

```sh
bun run typecheck
bunx eslint <所有改动文件>
bun test tests/diagnostics tests/shutdown tests/observability
bun test tests/diagnostics/backend-flush-contract.it.test.ts tests/diagnostics/durable-writer.unit.test.ts --rerun-each 25
bun test tests/shutdown/shutdown-signals.it.test.ts --rerun-each 25
git diff --check
```

高风险改动必须做 merged-state 独立评审；评审 prompt 从上述不变量独立推导 oracle，不得只审 diff 或相信测试名。

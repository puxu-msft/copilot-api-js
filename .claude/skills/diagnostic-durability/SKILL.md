---
name: diagnostic-durability
description: 当修改 copilot-api-js 的结构化诊断文件、BootstrapDiagnosticSpool、CountingDestination、DurableFileWriter、pino-roll rotation、diagnostic shutdown barrier、WAL replay/claim/corrupt recovery、或排查 Ctrl+C 停在 History and telemetry barriers completed 时使用——全会话 WAL-first mirror、accepted-generation checkpoint、file+directory fsync、内容寻址 delivery 幂等恢复、generation-keyed lifecycle queue，以及 backend contract→primitive→sink→production seam→PTY 的测试真相域。
---

# Diagnostic durability

## 先定边界

不要在 `StructuredFileSink` 内修 flush、fsync、rotation 或 shutdown 状态机。活模块职责固定为：

- `CountingDestination`：公开字节记账和 sticky drop/error；不读 SonicBoom `_len` 等私有字段。
- `DurableFileWriter`：accepted-generation checkpoint、strict flush progress、checkpoint 串行、roll path/segment 稳定、file+directory fsync、marker、end/close。
- `StructuredFileSink`：Pino serialization、record union、file threshold 和串行 maintenance。
- `BootstrapDiagnosticSpool`：全会话 WAL 的唯一 bus owner；WAL write 完成后才 mirror sink。
- `diagnostics/file/index.ts`：generation-keyed attach/disable/shutdown lifecycle queue；生产 `activeSink` facade。

冻结意图看 `docs/rfc/2026-07-17-tui-structured-logging.md` §7.2/§7.4，当前关系看 `docs/DESIGN.md`，跨子系统关停顺序看 `docs/lifecycle.md`，踩坑复盘看 `docs/audits/2026-07-18-diagnostic-durability-retrospective.md`。

## Durability 不变量

1. 每次 checkpoint 同步冻结调用时 cumulative `acceptedBytes` 为 generation target；之后 producer 属下一 generation，不能拖住当前 checkpoint，也不能被误判 no-progress。
2. `settledBytes = writtenBytes + droppedBytes`。每次 backend flush 必须使 target settled 严格前进，否则显式失败；不得无限等待。
3. target settle 后等待 pino-roll active path 与 segment namespace 稳定，再 fsync 全部相关 regular segment 和父目录。
4. Shutdown 顺序是 seal/fsync WAL producer→普通 sink generation durable→写唯一 `shutdown_diagnostic_sealing` marker→marker generation durable→end exactly once→await close/error→成功才删除并 directory-fsync WAL。
5. drop、sync write throw、async error、fsync、roll stability、marker drop、maintenance failure 都是 sticky failure；失败路径仍 best-effort 收敛资源，但不得进入成功 latch。
6. `pino-roll` 数值 size 的单位是 MiB；项目配置是 bytes，adapter 必须传 `${bytes}b`。Pino logger 必须设 `level:"trace"`，file threshold 由 `StructuredFileSink.writeRecord()` 单一裁决。

## WAL 与恢复不变量

1. WAL 是全会话 owner，不是只活到 writer ready 的 bootstrap buffer。Live record 必须先完整写 WAL，再携同一 delivery identity mirror sink。
2. Delivery identity 是 `(spoolId, sequence, digest)`；digest 对不含 delivery 的完整 payload 计算。长期记录只有结构完整且重算 digest 匹配，才证明 committed。
3. Replay 对 WAL 做两次独立的流式遍历：第一遍只收 wanted delivery identities，长期 scanner 只保 wanted 命中；第二遍逐条 replay 未提交记录。每次遍历都会 parse 全部 WAL 行，但不把 records 数组物化在内存中；legacy 行会在 parser 边界派生稳定 delivery identity。
4. WAL 存活期间禁止 runtime prune，避免 committed ledger 在 WAL 删除前消失。Clean shutdown 删除 WAL 后，跨启动 retention 负责旧 segment。
5. Orphan 先按 pid+procStartTicks 判死，再原子 rename claim；claim owner 后缀必须替换而非嵌套，允许任意多代 claimant 崩溃后恢复。
6. `writeSync` 必须处理短写和零进展；spool 创建、claim、corrupt rename、删除都必须 fsync 父目录。
7. JSON 语法损坏和 JSON-valid 语义损坏都要隔离到 `.corrupt-*`，合法前缀继续恢复；不得让 poison artifact 永久 wedge，也不得静默删除证据。

## Lifecycle 不变量

- attach、disable、shutdown 全部经过同一 lifecycle queue。
- Attach 调用入队前开启 writable generation；`shutdownBarriers` 按 generation key，两个同 generation caller 共享同一 promise，queued attach 后的 shutdown 必须获得新 barrier。
- 依赖的 bus 层契约：`publishAndFlush()` 的 filter/sync/async subscriber failure 和 deadline 必须进入 `FlushResult.failures`；shutdown success/failed/forcing 所有 awaited 发布都显式处理 failure。
- `stopped` 只在 History、Telemetry、Diagnostic 和 observer terminal notification 全成功后成立；observer socket close 是 best-effort 资源收敛，不是成功 barrier。失败不 resolve 成功 latch。

## 测试真相域

| 层 | 唯一真相 | 入口 |
|---|---|---|
| backend contract | Pinned Bun/Node SonicBoom/pino-roll 的真实 callback、size、rotation 行为 | `tests/diagnostics/backend-flush-contract.it.test.ts`、`durable-writer-runtime.it.test.ts` |
| primitive unit | generation、strict progress、failure、fsync、roll stability、marker、close 顺序 | `tests/diagnostics/durable-writer.unit.test.ts`、`counting-destination.unit.test.ts` |
| sink integration | Pino level、record union、threshold、权限、drop | `tests/diagnostics/structured-file-sink.it.test.ts` |
| architecture guard | sink 不得重新拥有 flush/fsync；WAL 必须保持生产 bus owner | `tests/diagnostics/module-boundaries.unit.test.ts` |
| production seam | WAL、delivery digest、claim、corrupt、cutover failure、generation、真实 rotation | `tests/diagnostics/bootstrap-spool.it.test.ts`、`shutdown-barrier.it.test.ts`、`multiprocess-rotation.it.test.ts`、`segment-files.it.test.ts` |
| process oracle | 真前台 SIGINT 的 exit code、artifact 和 cooked/raw 终端 | `tests/shutdown/shutdown-signals.it.test.ts` |

禁止用单个 wall-clock race 混测这些层。每个 “rotation/exactly-once/production wired” 测试必须先断言目标路径确实触发；exactly-once 用 `Map<id,count>`，不能用 `Set`。

## 修改后的验证

```sh
bun run typecheck
bunx eslint <所有改动文件>
bun test tests/diagnostics tests/shutdown tests/observability
bun test tests/diagnostics/backend-flush-contract.it.test.ts tests/diagnostics/durable-writer.unit.test.ts --rerun-each 25
bun test tests/shutdown/shutdown-signals.it.test.ts --test-name-pattern 'production diagnostic barrier' --rerun-each 25
git diff --check
```

高风险改动必须做 merged-state 独立评审；评审 prompt 从上述不变量独立推导 oracle，不得只审 diff 或相信测试名。

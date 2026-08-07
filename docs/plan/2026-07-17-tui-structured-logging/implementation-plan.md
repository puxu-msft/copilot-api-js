# TUI 模块化与结构化诊断日志详细实施计划

## 0. 执行约定

本计划以冻结 RFC 为唯一设计输入。九个 Phase 是集成顺序，不等同于一个 commit；每个 Task 是建议的最小语义提交单元。tests-first 的固定循环是：新增或收紧 oracle→运行精确 test filter 并确认因目标缺失而红→实现最小完整长期形状→运行 task gate→运行阶段 gate→用精确 pathspec 提交。

所有行为保持型 golden 必须先在改动前的旧路径上通过；所有“零泄漏、零重复、无异常、无残留”结论必须先用故意坏实现或禁用保护的正样本证明 oracle 确实触达目标。Phase 1 不提交长期 skip/todo 或冻结错误行为的断言；属于后续阶段的红测在其 owner task 内先红后绿。

建议提交信息按 `test:`、`fix:`、`feat:`、`refactor:`、`perf:`、`docs:` 分开；任何原子 cutover 的测试与生产变更必须放在同一个终态提交内。

## Phase 1：Baseline——恢复可信基线并预捕获 oracle

**依赖：** 无。

### Task 1.1：修复 stale observability fixture

- 主要文件：`tests/observability/console-thinking.unit.test.ts`、必要时只读核对 `src/lib/tui/terminal-ui.ts` 与 `src/lib/observability/events.ts`。
- Tests-first oracle：先运行现有文件复现 3 个稳定失败；把 fixture 的 feature event 改为 executing/streaming context，只在 terminal event 使用 completed context，证明 anti-resurrection 生产契约不被放宽。
- Commit invariant：测试修复不修改生产 guard；console-thinking 全文件绿，原本 3 个 false-red 消失。
- 命令：`bun test tests/observability/console-thinking.unit.test.ts && bun run typecheck && git diff --check`。
- 建议提交：`test: repair terminal thinking fixtures`。

### Task 1.2：移除 PTY checkout path 假设

- 主要文件：`tests/tui/pty/harness.ts`、`tests/tui/pty/harness.pty.test.ts`。
- Tests-first oracle：增加从非仓库 cwd 启动 harness 的测试，先确认硬编码 `/home/xp/src/copilot-api-js` 时失败，再从 `import.meta.dir` 向上解析 worktree root；加入错误 root 正样本，证明测试不是只验证路径存在。
- Commit invariant：PTY driver cwd 与 clone/worktree 绝对位置无关，不修改生产 TUI。
- 命令：`bun test tests/tui/pty/harness.pty.test.ts && (cd /tmp && bun test "$OLDPWD/tests/tui/pty/harness.pty.test.ts") && git diff --check`。
- 建议提交：`test: make tui pty harness checkout-independent`。

### Task 1.3：预捕获 terminal golden 与故障 oracle 正样本

- 主要文件：`tests/tui/golden-fixture.unit.test.ts`、`tests/observability/console-system-log.unit.test.ts`、`tests/tui/pty/clean-restore.pty.test.ts`、`tests/tui/pty/detail-no-clobber.pty.test.ts`、`tests/tui/pty/footer-pinned.pty.test.ts`、`tests/tui/pty/no-eaten-lines.pty.test.ts`、`tests/tui/pty/resize-reanchor.pty.test.ts`。
- Tests-first oracle：冻结当前 `system.log` human projection、至少一条独立 `system.request_line` 的 terminal 输出与 request-line 交错顺序、DECSTBM/alternate-screen restore 与 replay exactly-once；每个 PTY oracle至少保留一个故意坏 driver/mutation 正样本，证明缺少 restore、重复行或 footer 漂移会失败。
- Commit invariant：golden 在结构化迁移前旧实现上全绿；仅锁定 RFC 要求保持的 terminal 可观察行为，不锁定共享文本 FileSink 格式或已知 q/selection 缺陷。
- 命令：`bun test tests/tui/golden-fixture.unit.test.ts tests/observability/console-system-log.unit.test.ts && bun run test:pty && git diff --check`。
- 建议提交：`test: capture tui logging migration baseline`。

### Phase 1 gate

`bun test tests/tui tests/observability && bun run test:pty && bun run typecheck && git diff --check`。

## Phase 2：P0 containment——阻断 credential、logger 自伤与故障放大

**依赖：** Phase 1。

### Task 2.1：producer credential containment 与 sensitive-once 输出

- 主要文件：`src/lib/token/providers/device-auth.ts`、`src/lib/token/github-client.ts`、`src/lib/token/providers/base.ts`、`src/auth.ts`、`src/start.ts`；新建 `src/lib/tui/sensitive-output.ts`；测试新建 `tests/token/diagnostic-redaction.it.test.ts`、`tests/tui/sensitive-output.unit.test.ts`。
- Tests-first oracle：使用唯一随机 probe token，先证明旧 verbose 路径可在 terminal/file capture 命中；随后断言默认与 verbose 只记录状态、interval、expiry、OAuth error code，原 response 与 token 字节零命中。显式 `--show-github-token` 只经 `SensitiveOutputPort.writeOnce("github-token", token)` 在健康 TTY 命中一次，非 TTY/故障 terminal 拒绝显示且不回退到 emergency/file/history。
- Commit invariant：credential 原文不再进入 consola/bus；show-token 全进程 dedupe；one-shot 与服务实现共享接口但各自拥有正确输出 owner。
- 命令：`bun test tests/token/diagnostic-redaction.it.test.ts tests/tui/sensitive-output.unit.test.ts && bun run typecheck && git diff --check`。
- 建议提交：`fix: contain credential diagnostic output`。

### Task 2.2：legacy 文件权限止血

- 主要文件：`src/lib/observability/sinks/file.ts`、`src/lib/config/paths.ts`、`tests/observability/file-sink.unit.test.ts`。
- Tests-first oracle：在受控临时目录创建宽权限目录与 regular file，先确认旧实现不收紧，再断言目录 `0700`、artifact `0600`；symlink、FIFO、device 一律拒绝且 producer 不抛。
- Commit invariant：Phase 4 退役前的 legacy FileSink 也不会创建过宽 artifact；不得引入新的共享 rotation 协议或长期兼容层。
- 命令：`bun test tests/observability/file-sink.unit.test.ts && bun run typecheck && git diff --check`。
- 建议提交：`fix: harden legacy diagnostic file permissions`。

### Task 2.3：ObservabilityBus 完整 subscriber isolation

- 主要文件：`src/lib/observability/bus.ts`、`src/lib/observability/index.ts`、所有现有 subscriber 调用点（`src/lib/tui/terminal-ui.ts`、`src/lib/observability/sinks/{file,ws,history,telemetry,calibration,calibration-failure}.ts` 及 `rg 'bus\.subscribe' src tests` 的全部命中）、`tests/observability/bus.unit.test.ts`、`tests/observability/sink-ordering.unit.test.ts`；必要时新增 `src/lib/observability/sink-failure-metrics.ts`。
- Tests-first oracle：依次注入 filter throw、handler throw、thenable reject、`onSubscriberError` 自身 throw，断言后续 subscriber 仍按 publish 顺序恰一次收到事件；用故意把 filter 放回 try/catch 外的正样本证明测试变红。
- Commit invariant：API 固定为 `subscribe(name, handler, filter?)`，name 进入错误报告与 `observability_sink_failures_total{sink,phase}`；内部诊断不调用 consola，hook 失败只增加 silent counter。
- 命令：`bun test tests/observability/bus.unit.test.ts tests/observability/sink-ordering.unit.test.ts && bun run typecheck && git diff --check`。
- 建议提交：`fix: isolate observability subscriber failures`。

### Task 2.4：legacy consola adapter never-throw 与独立 emergency owner

- 主要文件：`src/lib/observability/republish.ts`、`src/lib/tui/terminal-coordinator.ts`；新建 `src/lib/diagnostics/emergency-output.ts` 与 `src/lib/diagnostics/safe-project.ts`；测试扩展 `tests/observability/console-system-log.unit.test.ts`、`tests/tui/terminal-coordinator.unit.test.ts`，新建 `tests/diagnostics/emergency-output.unit.test.ts`。
- Tests-first oracle：BigInt、循环引用、throwing getter/Proxy/toJSON、error-like、stdout sync throw、stdout async `error`、stderr sync/async failure、stdout+stderr 同坏均不向 logger caller 抛；error cause/code/status 暂以安全结构保留，为 Phase 3 canonical codec 提供入口。
- Commit invariant：`EmergencyOutput` 在 bus/consola 之前初始化且 never-throw；stdout 首次不可恢复故障熔断 terminal coordinator，stderr 也有独立 fault latch，双坏只累计 silent counter；不得用 catch 后再次写同一坏 stdout。
- 命令：`bun test tests/observability/console-system-log.unit.test.ts tests/tui/terminal-coordinator.unit.test.ts tests/diagnostics/emergency-output.unit.test.ts && bun run typecheck && git diff --check`。
- 建议提交：`fix: contain terminal and diagnostic output faults`。

### Phase 2 gate

`bun test tests/token tests/diagnostics tests/observability tests/tui/terminal-coordinator.unit.test.ts tests/tui/sensitive-output.unit.test.ts && bun run typecheck && bun run lint:all && git diff --check`。

## Phase 3：Structured core——建立 canonical event 并原子切换 event kind

**依赖：** Phase 2。

### Task 3.1：引入依赖与锁定 Bun/Node 能力边界

- 主要文件：`package.json`、`bun.lock`；新建 `tests/diagnostics/fixtures/backend-capability-probe.mjs`、`tests/diagnostics/backend-capability.unit.test.ts`。
- Tests-first oracle：Bun 与 Node 都执行 probe，覆盖 BigInt、循环值、Error cause/code/status、path redaction、逐行 JSON parse、无 duplicate keys、destination ready/close；增加 `find node_modules -name binding.gyp` 零结果守卫。
- Commit invariant：依赖精确为 `pino@10.3.1`、`pino-roll@4.0.0`、`safe-stable-stringify@2.5.0`、`serialize-error@13.0.1`；不启用 worker transport，不让 Pino 写 stdout。
- 命令：`bun add --exact pino@10.3.1 pino-roll@4.0.0 safe-stable-stringify@2.5.0 serialize-error@13.0.1 && bun tests/diagnostics/fixtures/backend-capability-probe.mjs && node tests/diagnostics/fixtures/backend-capability-probe.mjs && test -z "$(find node_modules -name binding.gyp -print -quit)" && git diff --check`。`bun install --frozen-lockfile` 只在后续 CI/clean checkout 验证已提交 lock，不紧跟 `bun add`。
- 建议提交：`build: add structured diagnostic dependencies`。

### Task 3.2：实现 bounded snapshot、error normalization、redaction 与 deep freeze

- 主要文件：新建 `src/lib/diagnostics/types.ts`、`src/lib/diagnostics/snapshot.ts`、`src/lib/diagnostics/error.ts`、`src/lib/diagnostics/redaction.ts`、`src/lib/diagnostics/freeze.ts`、`src/lib/diagnostics/index.ts`；新建 `tests/diagnostics/snapshot.unit.test.ts`、`tests/diagnostics/redaction.unit.test.ts`、`tests/diagnostics/error.unit.test.ts`。
- Tests-first oracle：完整覆盖 RFC `DiagnosticValue` algebra、depth/breadth/string/total-byte caps、null-prototype dictionary、`__proto__`、getter/Proxy/toJSON throw、cross-realm/error-like、producer mutation、subscriber mutation与随机 credential；round-trip 后 NaN/±Infinity/-0/BigInt/undefined/Symbol/function/circular/truncated 仍可辨识。
- Commit invariant：unknown 只存在于 facade/adapter 入口；顺序固定为 snapshot/project→redact→deep-freeze；任何入口值都不能使 logger throw，任何 sink 都只能看到已 redacted frozen value object。
- 命令：`bun test tests/diagnostics/snapshot.unit.test.ts tests/diagnostics/redaction.unit.test.ts tests/diagnostics/error.unit.test.ts && bun run typecheck && git diff --check`。
- 建议提交：`feat: add canonical diagnostic value codec`。

### Task 3.3：实现 native logger facade 与 consola compatibility adapter

- 主要文件：新建 `src/lib/diagnostics/logger.ts`、`src/lib/diagnostics/consola-adapter.ts`；修改 `src/lib/observability/republish.ts`、`src/lib/observability/index.ts`、`src/start.ts`；新建 `tests/diagnostics/logger.unit.test.ts`、`tests/diagnostics/consola-adapter.unit.test.ts`。
- Tests-first oracle：`child()` 在创建时冻结 bindings；原始 `logObj.date` 优先；第一个 error-like 进入 `error`，其余 args 进入 `fields.args`；message 从 redacted snapshot 派生；早期未初始化 publisher 走 synthetic process identity emergency fallback且不递归 consola。
- Commit invariant：唯一 facade 不拥有 router/writer；compatibility adapter 不反解析旧 `[scope]` 前缀；native 与 adapter 都产生同一个 `DiagnosticEvent` schemaVersion 1。
- 命令：`bun test tests/diagnostics/logger.unit.test.ts tests/diagnostics/consola-adapter.unit.test.ts && bun run typecheck && git diff --check`。
- 建议提交：`feat: add scoped diagnostic logger facade`。

### Task 3.4：原子切换 `system.log`→`system.diagnostic`

- 主要文件：`src/lib/observability/events.ts`、`src/lib/observability/bus.ts`、`src/lib/observability/sinks/file.ts`、`src/lib/observability/sinks/ws.ts`、`src/lib/tui/terminal-ui.ts`、`src/lib/tui/render/syslog.ts`、`src/lib/history/persist-guard.ts`、所有 `system.log` 测试与 PTY drivers；使用 `git mv` 将 terminal projection 与测试分别迁为 `src/lib/tui/render/diagnostic.ts`、`tests/tui/render/diagnostic.unit.test.ts`，不保留误导性的 syslog 命名。
- Tests-first oracle：先把 golden consumer 改为 `system.diagnostic` 并确认类型/测试红；先用 `rg 'system\.log' src tests` 建完整命中清单，再改 event union，让 TypeScript exhaustive switch 暴露遗漏，并在同一提交内切换 publisher、全部 switch/filter/driver。WS 必须新增显式 `case "system.diagnostic": return`，不是借 default 静默漏接。Terminal human projection除 RFC 明示 sanitizer/redaction差异外逐字等价；故意双挂旧/新 event 的正样本必须导致 exactly-once 测试失败。
- Commit invariant：生产事件联合不存在长期双轨；terminal 与 legacy file adapter都消费 frozen canonical event；`system.request_line` 保持独立且不受 diagnostic level 过滤；WS 明确忽略 diagnostic 而非遗漏 switch 分支。
- 命令：`bun test tests/diagnostics tests/observability tests/tui/golden-fixture.unit.test.ts tests/tui/render && bun run test:pty && bun run typecheck && rg 'system\.log' src tests || true && git diff --check`。
- 建议提交：`feat: cut over to structured diagnostic events`。

### Phase 3 gate

`bun test tests/diagnostics tests/observability tests/tui && bun run test:pty && bun run typecheck && bun run lint:all && git diff --check`。

## Phase 4：Structured file——per-boot NDJSON、retention 与 shutdown durability

**依赖：** Phase 3。

### Task 4.1：CountingDestination 与 durable writer primitive

- 主要文件：新建 `src/lib/diagnostics/file/counting-destination.ts`、`src/lib/diagnostics/file/durable-writer.ts`、`src/lib/diagnostics/file/types.ts`；新建 `tests/diagnostics/counting-destination.unit.test.ts`、`tests/diagnostics/durable-writer.it.test.ts`。
- Tests-first oracle：精确 UTF-8 serialized line bytes、sync drop、async write/drain、queued/in-flight/dropped、oversized、ENOSPC/EACCES/error/post-close；Bun+Node 顺序必须满足 write completion < fsync completion < barrier success。另以默认 `minLength=0` 的 callback 假 barrier 作为会失败的正样本。
- Commit invariant：不读取 SonicBoom 私有字段；显式正值 `minLength/maxLength` 与 mode 0600；`flushSync()` 不作为 durability 真相；所有 writer 错误转 health/emergency，不回抛 bus producer。
- 命令：`bun test tests/diagnostics/counting-destination.unit.test.ts tests/diagnostics/durable-writer.it.test.ts && bun tests/diagnostics/fixtures/backend-capability-probe.mjs && node tests/diagnostics/fixtures/backend-capability-probe.mjs && git diff --check`。
- 建议提交：`feat: add durable diagnostic destination`。

### Task 4.2：process identity、owner manifest、segment registry 与 retention

- 主要文件：扩展 `src/lib/process-identity.ts` 的 `ProcessIdentity`（新增 `procStartTicks?: number`）及所有下游类型消费者；新建 `src/lib/diagnostics/file/manifest.ts`、`src/lib/diagnostics/file/segment-registry.ts`、`src/lib/diagnostics/file/retention.ts`；测试扩展 `tests/infra/process-identity.unit.test.ts`，新建 `tests/diagnostics/manifest.it.test.ts`、`tests/diagnostics/retention.it.test.ts`。
- Tests-first oracle：Linux `/proc/<pid>/stat` 在 comm 含空格与 `)` 时仍正确解析 field 22；manifest 对临时文件写、file fsync、rename、directory fsync 的每个 crash boundary可恢复；PID reuse、活 owner、死 owner、missing/corrupt/insufficient manifest、`/proc` EACCES、symlink/FIFO/device、orphan spool、双 sweep ENOENT均符合保守协议。
- Commit invariant：writer 启动前 manifest durable；只删除 owner dead且过期的匹配 regular file；所有 segment 删除成功后才删 manifest并 fsync目录；manifest跨 graceful close保留。
- 命令：`bun test tests/infra/process-identity.unit.test.ts tests/diagnostics/manifest.it.test.ts tests/diagnostics/retention.it.test.ts && bun run typecheck && git diff --check`。
- 建议提交：`feat: add owned diagnostic artifact retention`。

### Task 4.3：StructuredFileSink 与 request-line 判别联合

- 主要文件：新建 `src/lib/diagnostics/file/structured-file-sink.ts`、`src/lib/diagnostics/file/pino-backend.ts`、`src/lib/diagnostics/file/health.ts`；修改 `src/lib/observability/events.ts`、`src/lib/observability/index.ts`；新建 `tests/diagnostics/structured-file-sink.it.test.ts`、`tests/diagnostics/multiprocess-rotation.it.test.ts`。
- Tests-first oracle：每行独立 JSON.parse、Pino envelope 只有 `record` 且无 duplicate key；Pino path redaction作为canonical redaction后的第三层防线；payload严格二选一 `{recordType:"diagnostic", diagnostic}` 或 `{recordType:"request-line", ...}`；N=0/1/2/7 pruning、unlink EACCES、roll path更新、两进程各1000条并发 rotation连续25轮 exactly-once且零 ENOENT。
- Commit invariant：每进程只拥有 `copilot-api.<bootTime>.<pid>.*.ndjson`；不给 pino-roll 传 `limit`；真实 destination.file进入自有 registry；active artifact path进入启动banner与状态API；request-line terminal+file exactly-once且绕过 diagnostic level。
- 命令：`bun test tests/diagnostics/structured-file-sink.it.test.ts tests/diagnostics/multiprocess-rotation.it.test.ts && bun run typecheck && git diff --check`。`multiprocess-rotation.it.test.ts` 自身执行25轮并在首次失败时保留两进程artifact。
- 建议提交：`feat: add per-boot structured diagnostic files`。

### Task 4.4：bootstrap spool 与原子 sink cutover

- 主要文件：新建 `src/lib/diagnostics/bootstrap-spool.ts`、`src/lib/tui/terminal-sink-slot.ts`、`tests/diagnostics/bootstrap-spool.it.test.ts`；修改 `src/start.ts`、`src/lib/observability/sinks/file.ts`、`src/lib/tui/index.ts`、`tests/observability/file-sink.unit.test.ts`。
- Tests-first oracle：在切点前、slot swap同步操作两侧、切点后注入单调 sequence，terminal每条恰一次、file每条恰一次；故意双挂 delegate会红；config parse/identity/writer ready/replay/durable任一点失败都保持 terminal恰一次、spool保留且不向 bus replay；file logging disabled时执行spool close→fsync→unlink→directory fsync且不做terminal replay；启动发现本命名协议 orphan spool 时按 RFC 恢复/保留/retention，不得阻塞当前 bootstrap。
- Commit invariant：启动顺序固定为 EmergencyOutput→bus/logger→永久 TerminalSinkSlot+secure spool→config→identity→slot swap→writer ready→file-only replay→durable→unlink+directory fsync；同一原子提交删除旧共享 FileSink接线与实现，不保留双轨。
- 命令：`bun test tests/diagnostics/bootstrap-spool.it.test.ts tests/diagnostics/structured-file-sink.it.test.ts tests/observability/file-sink.unit.test.ts tests/tui/golden-fixture.unit.test.ts && bun run typecheck && rg 'attachFileSink|class FileSink|copilot-api\.log' src tests || true && git diff --check`。
- 建议提交：`feat: atomically cut over structured file logging`。

### Task 4.5：配置、health 与 shutdown barrier

- 主要文件：`src/lib/config/schema.ts`、`src/lib/config/config.ts`、`src/lib/state.ts`、`config.yaml`、`config.example.yaml`、`src/start.ts`、`src/lib/shutdown.ts`、`src/lib/observability/events.ts` 及所有处理 system shutdown exhaustive switch 的 subscribers；新建 `src/lib/diagnostics/shutdown.ts`；测试扩展 `tests/config/bundled-config.unit.test.ts`、`tests/config/config-hot-reload.it.test.ts`、`tests/config/config-schema-json-export.unit.test.ts`、`tests/shutdown/shutdown.unit.test.ts`，新建 `tests/diagnostics/shutdown-barrier.it.test.ts`。
- Tests-first oracle：配置默认值与 0 语义、terminal/file level热重载、restart-only变更warn-once；`finalize()` 给 History、Telemetry、Diagnostic 三个 barrier 各自独立 try/catch 并统一聚合 failures，前者失败也必须继续执行后者；shutdown顺序覆盖 cooked→seal producers→History/Telemetry all-settled→diagnostic marker/durable/end/close→WS failed/completed终态→human complete。新增 `system.shutdown_failed` 后同步更新 WsSink、TerminalUi/slot 等所有 exhaustive switch；marker exactly-once且不drop；第二信号不等待。
- Commit invariant：`system.shutdown_failed {errors}` 是真实失败终态；不得先发 finalized再回退；writer close后logger只记 dropped-after-close；正常 success只在所有 barrier成功后可见。
- 命令：`bun test tests/config/bundled-config.unit.test.ts tests/config/config-hot-reload.it.test.ts tests/config/config-schema-json-export.unit.test.ts tests/shutdown/shutdown.unit.test.ts tests/diagnostics/shutdown-barrier.it.test.ts && bun run generate:config-schema && bun run typecheck && git diff --check`。
- 建议提交：`feat: integrate diagnostic durability lifecycle`。

### Phase 4 gate

`bun test tests/diagnostics tests/observability tests/config tests/shutdown tests/infra/process-identity.unit.test.ts && bun run typecheck && bun run lint:all && git diff --check`。

## Phase 5：TUI store/controller——纯 reducer 与 ID-based identity

**依赖：** Phase 4（逻辑上只需 Phase 3，但本 worktree 固定串行 4→5，故 gate 也必须保持 Phase 4 诊断测试绿）。

### Task 5.1：抽取 ActiveRequestStore

- 主要文件：新建 `src/lib/tui/active-request-store.ts`、`tests/tui/active-request-store.unit.test.ts`；修改 `src/lib/tui/terminal-ui.ts`、`src/lib/tui/agent-ordinal-registry.ts`、`tests/tui/terminal-ui-response-thinking.unit.test.ts`、`tests/tui/terminal-ui-usage.unit.test.ts`、`tests/tui/terminated-no-resurrect.unit.test.ts`、`tests/pipeline/pipeline-retry-tui.unit.test.ts`。
- Tests-first oracle：在旧 `TerminalUi` 上先捕获 active Map、attempt merge、feature/thinking/recovered-tool projection、terminal line effect序列；新 store 对同一 event stream产生等价 snapshot/effects，且不读墙钟、不写终端、不拥有 selection。
- Commit invariant：store是纯 event reducer；业务 projection从 `TerminalUi` 单点删除而非复制；anti-resurrection、attempt ordering与request-line exactly-once保持。
- 命令：`bun test tests/tui/active-request-store.unit.test.ts tests/tui/terminal-ui-response-thinking.unit.test.ts tests/tui/terminal-ui-usage.unit.test.ts tests/tui/terminated-no-resurrect.unit.test.ts tests/pipeline/pipeline-retry-tui.unit.test.ts && bun run typecheck && git diff --check`。
- 建议提交：`refactor: extract active request store`。

### Task 5.2：用 request id 重写 UiController reconciliation并修 q

- 主要文件：`src/lib/tui/controller.ts`、`src/lib/tui/input/keys.ts`、`src/lib/tui/render/panel.ts`、`src/lib/tui/terminal-ui.ts`、`tests/tui/controller.unit.test.ts`、`tests/tui/input/keys.unit.test.ts`、`tests/tui/terminal-ui-interactive.unit.test.ts`。
- Tests-first oracle：selected sibling终结、selected row终结、last row终结三组先红；id仍在则保留，被删则旧位置下一个→上一个，空列表collapsed，detail id消失回panel；q/Ctrl-C/Ctrl-D分别解码但均调用 `handleShutdownSignal("SIGINT")` 恰一次。
- Commit invariant：controller真值只有 `selectedRequestId/detailRequestId`，index仅render时派生；logical view总先收敛，再决定是否需要terminal bytes；帮助栏q契约与实现一致。
- 命令：`bun test tests/tui/controller.unit.test.ts tests/tui/input/keys.unit.test.ts tests/tui/terminal-ui-interactive.unit.test.ts && bun run typecheck && git diff --check`。
- 建议提交：`fix: reconcile tui state by request identity`。

### Phase 5 gate

`bun test tests/tui tests/pipeline/pipeline-retry-tui.unit.test.ts tests/diagnostics && bun run test:pty && bun run typecheck && git diff --check`。

## Phase 6：TUI session/input/output——stateful protocol与单一 side-effect owner

**依赖：** Phase 5。

### Task 6.1：实现 stateful KeyDecoder

- 主要文件：重写 `src/lib/tui/input/keys.ts`，必要时新建 `src/lib/tui/input/key-decoder.ts`；扩展 `tests/tui/input/keys.unit.test.ts`，新建 `tests/tui/input/key-decoder.unit.test.ts`。
- Tests-first oracle：arrow、SS3、PgUp/PgDn、Home/End、UTF-8按1/2/3 chunk拆分；lone ESC 50ms timer；后续chunk取消同generation timer；未知完整CSI整体忽略；destroy清timer；timer callback never-throw。
- Commit invariant：decoder不把协议语义藏成另一个键；q/Ctrl-C/Ctrl-D/Ctrl-Z输出独立semantic action；任意chunk边界不产生spurious escape或尾字节char。
- 命令：`bun test tests/tui/input/keys.unit.test.ts tests/tui/input/key-decoder.unit.test.ts && bun run typecheck && git diff --check`。
- 建议提交：`feat: add streaming terminal key decoder`。

### Task 6.2：实现 OutputArbiter 与 backpressure policy

- 主要文件：新建 `src/lib/tui/output-arbiter.ts`、`tests/tui/output-arbiter.unit.test.ts`；修改 `src/lib/tui/terminal-coordinator.ts`、`src/lib/tui/terminal-ui.ts`、`src/lib/diagnostics/emergency-output.ts`。
- Tests-first oracle：sync write throw、async error、unexpected close、destroyed/writableEnded、真实EPIPE子进程；backpressure时只保留latest repaint+有界日志队列；drain顺序；sensitive-once不进入replay；fault后producer与后续bus sink继续。
- Commit invariant：所有服务stdout side effect只在OutputArbiter；首次fault注销coordinator并停止redraw；`writeEmergency`只委派EmergencyOutput；不得保留TerminalUi直接`stdout.write`。
- 命令：`bun test tests/tui/output-arbiter.unit.test.ts tests/tui/terminal-coordinator.unit.test.ts tests/tui/terminal-ui-coordinator.unit.test.ts tests/observability/bus.unit.test.ts && bun run typecheck && rg 'stdout\.write' src/lib/tui && git diff --check`。grep只允许OutputArbiter或明确one-shot边界。
- 建议提交：`refactor: centralize tui output arbitration`。

### Task 6.3：实现 TerminalSession并收敛raw lifecycle

- 主要文件：新建 `src/lib/tui/terminal-session.ts`、`tests/tui/terminal-session.unit.test.ts`；修改 `src/lib/tui/terminal-ui.ts`、`src/lib/shutdown.ts`、`tests/tui/terminal-restore.unit.test.ts`、`tests/shutdown/shutdown-signals.pty.test.ts`。
- Tests-first oracle：attach/detach、raw/cooked、resize source、exit hook unregister、shutdown begin restore idempotence；第一次signal同步restore，不依赖active request；stdout fault也不能跳过stdin cooked finally。
- Commit invariant：TerminalSession独占stdin/raw/TTY lifecycle；TerminalUi不再直接setRawMode或注册process exit/resize hook；destroy成对解除所有listener。
- 命令：`bun test tests/tui/terminal-session.unit.test.ts tests/tui/terminal-restore.unit.test.ts tests/shutdown/shutdown-signals.pty.test.ts && bun run typecheck && rg 'setRawMode|SIGTSTP|SIGCONT' src/lib/tui && git diff --check`。
- 建议提交：`refactor: extract terminal session lifecycle`。

### Task 6.4：收敛 TerminalUi为薄编排器

- 主要文件：`src/lib/tui/terminal-ui.ts`、`src/lib/tui/index.ts`、`tests/tui/layer-boundaries.unit.test.ts`、全部 `tests/tui/terminal-ui-*.unit.test.ts`。
- Tests-first oracle：同一bus event/input/timer序列在拆分前后的golden与PTY结果等价；architecture test禁止TerminalUi重新拥有projection算法、raw hooks或直接write。
- Commit invariant：TerminalUi只执行bus→store→controller→effect/render→output和input→controller/session/shutdown；目标小于400行；依赖方向保持 leaves→orchestrator，不新增横向环。
- 命令：`bun test tests/tui && bun run test:pty && bun run typecheck && git diff --check`。
- 建议提交：`refactor: reduce terminal ui to orchestration`。

### Phase 6 gate

`bun test tests/tui tests/shutdown/shutdown-signals.pty.test.ts tests/observability && bun run test:pty && bun run typecheck && bun run lint:all && git diff --check`。

## Phase 7：Detail/capability——viewport、sanitizer、fallback与job control

**依赖：** Phase 6。

### Task 7.1：实现稳定detail document与viewport

- 主要文件：新建 `src/lib/tui/render/detail-document.ts`、`src/lib/tui/render/detail-viewport.ts`、`tests/tui/render/detail-viewport.unit.test.ts`；修改 `src/lib/tui/render/panel.ts`、`src/lib/tui/controller.ts`、`src/lib/tui/terminal-ui.ts`、`tests/tui/terminal-ui-interactive.unit.test.ts`。
- Tests-first oracle：50+ attempts在rows 3/10/24下通过up/down/PgUp/PgDn/Home/End全部可达；header/body/keybar固定；hidden-above/below正确；内容revision与24→30→12→40连续resize后clamp。
- Commit invariant：document lines有稳定key；viewport state归controller；render leaf纯函数且不读terminal/process。
- 命令：`bun test tests/tui/render/detail-viewport.unit.test.ts tests/tui/terminal-ui-interactive.unit.test.ts tests/tui/render/panel.unit.test.ts && bun run typecheck && git diff --check`。
- 建议提交：`feat: add scrollable tui detail viewport`。

### Task 7.2：统一terminal sanitizer与trusted ANSI边界

- 主要文件：新建 `src/lib/tui/render/sanitize.ts`、`tests/tui/render/sanitize.unit.test.ts`；修改 `src/lib/tui/render/footer.ts`、`src/lib/tui/render/panel.ts`、`src/lib/tui/render/diagnostic.ts`、`src/lib/observability/projections/log-line.ts`。
- Tests-first oracle：C0/C1、CSI、OSC8、OSC52、DCS、BEL、CRLF、tab、超长string、CJK/combining/emoji；恶意数据不能清屏、改标题、写clipboard或破坏DECSTBM，renderer自身trusted ANSI仍保持颜色与width。
- Commit invariant：外部数据只在human renderer末端sanitize；File NDJSON只依赖JSON escaping；legacy message ESC在canonical normalize阶段转义；producer不决定展示裁剪。
- 命令：`bun test tests/tui/render/sanitize.unit.test.ts tests/tui/render/footer.unit.test.ts tests/tui/render/panel.unit.test.ts tests/tui/render/diagnostic.unit.test.ts tests/tui/log-line-color.integration.test.ts && bun run typecheck && git diff --check`。
- 建议提交：`fix: enforce trusted terminal rendering boundaries`。

### Task 7.3：`TERM=dumb`、non-TTY与`--no-tui` capability fallback

- 主要文件：`src/start.ts`、`src/lib/config/schema.ts`、`src/lib/config/config.ts`、`src/lib/state.ts`、`config.yaml`、`config.example.yaml`、`src/lib/tui/terminal-session.ts`、`src/lib/tui/index.ts`；新建 `tests/tui/capability-fallback.it.test.ts`，扩展 config tests。
- Tests-first oracle：TERM=dumb、stdout pipe/file、无setRawMode、config `tui.enabled:false`、CLI `--no-tui`均无raw/DECSTBM/alt screen且仍输出plain diagnostic/request lines；CLI覆盖config；热改restart-only只warn-once。
- Commit invariant：capability只在startup冻结一次；plain mode仍通过TerminalSinkSlot/OutputArbiter单owner，不旁路回consola stdout。
- 命令：`bun test tests/tui/capability-fallback.it.test.ts tests/config/bundled-config.unit.test.ts tests/config/config-hot-reload.it.test.ts && bun run generate:config-schema && bun run typecheck && git diff --check`。
- 建议提交：`feat: add explicit tui capability fallback`。

### Task 7.4：SIGTSTP/SIGCONT真job-control

- 主要文件：`src/lib/tui/terminal-session.ts`、`src/lib/tui/input/key-decoder.ts`；新建 `tests/tui/pty/suspend-resume.pty.test.ts`、`tests/tui/pty/fixtures/suspend_resume_pty.py`。
- Tests-first oracle：Python真PTY用`waitpid(WUNTRACED)`与`WIFSTOPPED`证明进程真挂起；顺序为drain restore→离alt→reset DECSTBM→显光标→detach→cooked→临时移除listener→self SIGTSTP；SIGCONT后重读size、attach、raw、rebuild、full repaint。无SIGTSTP平台Ctrl-Z no-op并提示一次。
- Commit invariant：仅state=`suspended`响应SIGCONT；重复signal与destroy幂等；恢复后输入与resize各只有一个listener。
- 命令：`bun test tests/tui/pty/suspend-resume.pty.test.ts tests/shutdown/shutdown-signals.pty.test.ts && bun run test:pty && bun run typecheck && git diff --check`。
- 建议提交：`feat: support terminal suspend and resume`。

### Phase 7 gate

`bun test tests/tui tests/config tests/shutdown/shutdown-signals.pty.test.ts && bun run test:pty && bun run typecheck && bun run lint:all && git diff --check`。

## Phase 8：Performance——以真实probe决定coalescing与buffer caps

**依赖：** Phase 4与Phase 7。

### Task 8.1：建立生产接线workload probe

- 主要文件：新建 `scripts/probe-tui-observability-load.ts`、`tests/diagnostics/workload-probe.it.test.ts`；只读生产接线 `src/lib/observability/bus.ts`、`src/lib/diagnostics/file/structured-file-sink.ts`、`src/lib/tui/output-arbiter.ts`。
- Tests-first oracle：probe必须复制真实bus→terminal/file sink接线，采集system diagnostic rate、stream_progress rate、event-loop gap、serialized bytes、queued/in-flight/dropped、stdout writableLength与drain latency；另跑受控慢destination正样本证明指标会升高。
- Commit invariant：阈值来自记录的probe结果而非拍脑袋；probe不连接4141主服务器、不使用真实credential或额度。
- 命令：`bun run scripts/probe-tui-observability-load.ts --profile baseline && bun test tests/diagnostics/workload-probe.it.test.ts && git diff --check`。
- 建议提交：`test: add observability workload probe`。

### Task 8.2：实现有界coalescing与最终flush

- 主要文件：`src/lib/observability/bus.ts`或新建 `src/lib/observability/stream-progress-coalescer.ts`、`src/lib/tui/output-arbiter.ts`、`src/lib/diagnostics/file/counting-destination.ts`、`src/lib/diagnostics/file/health.ts`；新建 `tests/observability/stream-progress-coalescer.unit.test.ts`，扩展 `tests/tui/output-arbiter.unit.test.ts` 与 writer tests。
- Tests-first oracle：fake timers驱动50–100ms latest-value coalesce；terminal event前强制flush最终累计；普通日志队列与repaint有界；overflow/drop进入health且一次性emergency可见；shutdown drain无遗漏。
- Commit invariant：不coalesce request terminal state、request-line、shutdown marker或emergency；rich canonical event在producer到sink间不被裁剪；presentation级latest-frame策略只存在OutputArbiter。
- 命令：`bun test tests/observability/stream-progress-coalescer.unit.test.ts tests/tui/output-arbiter.unit.test.ts tests/diagnostics/counting-destination.unit.test.ts tests/diagnostics/shutdown-barrier.it.test.ts && bun run scripts/probe-tui-observability-load.ts --profile bounded && bun run typecheck && git diff --check`。
- 建议提交：`perf: bound diagnostic and tui output queues`。

### Phase 8 gate

`bun test tests/observability tests/diagnostics tests/tui && bun run test:pty && bun run typecheck && bun run lint:all && git diff --check`，并比较baseline/bounded probe，要求吞吐不以丢失terminal state或durability为代价。

## Phase 9：Closeout——合并态验收、文档同步与审查

**依赖：** Phase 4、Phase 7与Phase 8全部完成。

### Task 9.1：全域测试与flaky矩阵

- 主要文件：不预设生产改动；失败必须回到其根因owner文件修复。必要时新增统一验收脚本 `scripts/verify-tui-structured-logging.ts`。
- Tests-first oracle：全量backend与PTY；no-eaten-lines/footer-pinned/detail replay/resize/clean restore各8–25连跑；双进程rotation 25轮；Bun+Node backend；credential四轨probe；shutdown fault matrix；非固定checkout path。
- Commit invariant：不得用重试掩盖flaky；任何偶发失败先定位时序/资源根因并固化回归测试；所有遇到的既有失败一并修复。
- 命令：`bun run test:backend && bun run test:pty && bun run typecheck && bun run lint:all && bun run build:backend && git diff --check`，另由验收脚本执行重复矩阵并在首次失败时保留artifact。
- 建议提交：仅在发现并修复独立根因时按语义提交；不要创建“make tests pass”混合提交。

### Task 9.2：文档、ADR、config与backlog同步

- 主要文件：`docs/DESIGN.md`、`docs/API.md`、`docs/coding-conventions.md`、`docs/decisions/2026-07-10-tui-terminal-ownership.md`、必要时新建structured diagnostic ADR、`docs/todo/deferred-backlog.md`、`README.md`、`config.yaml`、`config.example.yaml`、生成的config schema、当前RFC与本计划状态头。
- Tests-first oracle：跨文档grep确认不再把`system.log`、shared `copilot-api.log`、q no-op、TerminalUi直接raw/write或旧rotation描述为活路径；配置清单测试验证schema/state/bundled/example/hot-reload matrix一致。
- Commit invariant：`docs/DESIGN.md`反映活架构；ADR只追加已决定的终态及理由；已完成项从backlog移除，仍未实现的P2 abort/OSC52 copy继续明确保留；RFC与计划标记Implemented并引用落地提交范围。
- 命令：`rg 'system\.log|copilot-api\.log|q.*no-op|TerminalUi.*setRawMode' docs README.md src tests && bun test tests/config && bun run generate:config-schema && git diff --check`。
- 建议提交：`docs: document structured diagnostics and modular tui`。

### Task 9.3：独立合并态审查与最终修复

- 审查范围：冻结RFC、九阶段commit invariants、全部changed files、测试正样本、Bun/Node与PTY证据、文档一致性。
- 审查判据：长期完整形状，不接受ROI/YAGNI缩减；主动查找双owner、双publish、unsafe stringify、private SonicBoom字段、manifest误删、shutdown先finalized后failed、raw listener泄漏、无正样本的negative assertion与只测单边的seam false-green。
- Commit invariant：所有FAIL/WARN经独立代码或probe复核后归零；不采纳的意见记录事实依据；最终working tree只包含本特性预期改动。
- 命令：`git status --short && git diff --check && git log --oneline --decorate <base>..HEAD`，随后重跑Task 9.1全矩阵。
- 建议提交：按发现的语义拆分`fix:`/`test:`/`docs:`，禁止单个`chore: review fixes`吞并多个根因。

### Phase 9最终gate

1. `bun run test:backend`、`bun run test:pty`、`bun run typecheck`、`bun run lint:all`、`bun run build:backend`全部通过。
2. PTY核心oracle 8–25连跑、双进程logs 25轮、Bun+Node backend、credential四轨与shutdown durability顺序oracle全部有可复现绿证据。
3. `rg 'system\.log|attachFileSink|class FileSink|copilot-api\.log' src tests`无活代码残留；正样本已证明这些grep/test确实覆盖目标。
4. `TerminalUi`小于400行且无直接stdout/stdin/raw/process signal ownership；architecture tests对故意违规fixture会红。
5. 独立合并态对抗review归零，文档与实现一致，计划状态更新为Implemented。

# Deadline guard review

## G1 — per-attempt deadline

未发现 blocker 或 major。`firing aborts`（`tests/transport/dispatch-lifecycle.unit.test.ts:443-457`）在完全不调用 `setTimeout` 的错误实现下会因第 451 行期待 `signal.aborted === true` 而红；`completes before`（459-471）与 `deadlineMs 0`（473-482）都是负向断言，在同一错误实现下都会绿，调用方的说法正确。生产计时器在 `src/lib/transport/dispatch-lifecycle.ts:167-178`，完成时由 `complete()` 的第 86-93 行清除；前者已覆盖「超时必须终止并保留原因」，后两条分别覆盖成功结束及 disabled 输入不应误杀。`bun test tests/transport/dispatch-lifecycle.unit.test.ts`：21 pass、0 fail。注：第 459-471 行只能观察到完成后“不 abort”，不能独立证明 `clearTimeout` 被调用；这不足以构成只报 major/blocker 范围内的问题。

## G2 — shutdown wall-clock bounds

[major] `tests/shutdown/shutdown.unit.test.ts:1102-1120` — “only counts from THEN”并无能分辨力。错误实现若在 graceful shutdown 一开始就武装 50ms `abort_wait`（而非在第 50ms 的 graceful expiry 后再等 50ms），第 1113 行 30ms 时仍未 exit、1116 行 150ms 时已 exit，测试照绿，却会把硬退出上限提前 50ms。应在 50ms 与 100ms 之间加入断言，或用可控 clock 精确断言 `armAbortWait` 发生在 graceful expiry 后。

[major] `tests/shutdown/shutdown.unit.test.ts:1056-1073` — “LOSSLESSLY and lets finalize run”仅以 `shutdownHistoryFn` 被调用证明进入过 `finalize()`，不能区分遗漏 `drainModelOperationFinalizations`、History admission、Telemetry、Diagnostics 或 completion publish 的错误实现；这些任一持久化 barrier 被跳过时，`closeHistory`、`stopped` 与两个 request primitive 都仍可绿。应为全部 finalize seam 注入调用记录并断言顺序/各一次，至少覆盖所有承诺的 durability barrier。

其余逐条核验：1056-1073 会在不 arm/不 abandon、未调用 `reapInFlight`/`fail`、或不进入 History finalize 时红；1076-1087 会在 attribution/message 不对时红；1089-1100 会在零值仍终止请求时红；1123-1153 会在第二信号不 arm abort bound 或错误 exit code 时红。`tests/helpers/mock-tracker.ts:63-73` 对本路径的 settled/no-op 与 release 行为匹配 `src/lib/context/request.ts:1124-1126,1903-1913`，没有发现会把 graceful-wait attribution 调用吞掉的“友好 fake”。`bun test tests/shutdown/shutdown.unit.test.ts`：52 pass、0 fail。

## G3 — reversed schema/API guards

未发现 blocker 或 major。`tests/config/config-schema-json-export.unit.test.ts:39-55` 由顶层存在加两个 leaf 存在共同守住「shutdown section 应暴露且含两界」；删除 section、任一 leaf 或 JSON Schema 断链都会红。`tests/infra/api-endpoints-smoke.http.test.ts:90-110` 同时走真实 `createFullTestApp()` 的 `/api/config` 投影，守住两个 camelCase 字段存在且是 number；删除/错名/字符串投影会红。因此反转已用正向契约替换旧的“不得回来”契约，没有静默失去该契约应有的覆盖。

## G4 — bundled wall-clock defaults

未发现 blocker 或 major。拆分后 `tests/config/never-false-kill-legit-thinking.unit.test.ts:40-52` 分别钉住 `response_header: 0`、`stream_idle: 0`、`client_request_deadline: 0`；把后两者之一改成正数一定红。`upstream_request_deadline: 1200` 与 shutdown `600/60` 的精确值不是任意紧约束：ADR `docs/decisions/2026-08-11-shutdown-owns-bounded-waits-again.md:12-34` 记录用户明确裁决及精确语义，故第 55-77 行是在守已裁决配置（含总界 660），不是禁止正常的未决配置演进。批量运行三个 guard 文件时 Bun 在覆盖报告阶段报内部 `WriteFailed`，未将该环境错误当作测试红；源码与 ADR 证据如上。

## G5 — renamed deadline/abort integration tests

未发现 blocker 或 major。`tests/context/client-request-deadline.it.test.ts:32-86` 已把旧 `requestDeadline` 全部替为 live state 的 `clientRequestDeadline`，仍逐条守住正向 timer 终止＋lifecycle abort＋untrack、0 禁用、inspection manager 豁免、提前完成清 timer。`tests/transport/request-abort-unhandled.it.test.ts:145-217` 以仍存活的 request-level 原语 `reapInFlight()`／`fail()`（见 `src/lib/context/request.ts:1124-1126,1903-1913`，也是 `src/lib/shutdown.ts:725-728` 的调用形状）替代已删除 `_runReaperOnce`；AWAITED、detached-await、ABANDONED 三个拓扑各自均实际 abort 并断言 0 `unhandledRejection`。`bun test` 这两个文件：8 pass、0 fail。

## G6 — deleted reaper tests

未发现 blocker 或 major。被删文件的 five interval cases 只守 `computeReaperIntervalMs`（旧 `staleRequestMaxAge/3` 扫描公式），当前 `src/` 中已无该函数、`startReaper`、`stopReaper` 或 `_runReaperOnce` 的 live 实现；旧 context 的 six cases中“到龄扫描／未到龄不扫／0 不扫”亦随周期扫描消失。仍在的 request-level abort/fail/idempotency 已由 G5 的 145-217 行守住，精确 client deadline 由 G5 的 32-86 行守住。`shutdown.unit` 删除的两条只守 `stopReaper` 调用和可选 manager；`ShutdownDeps` 当前没有该依赖（`src/lib/shutdown.ts:257-300`），正常无 manager 路径被同文件大量 `createNoopDeps()` 调用覆盖。

## G7 — entry execution baseline

未发现 blocker 或 major。当前 `minimum_executed` 是 7619（`tests/infra/entry-test-discovery-baseline.json:2-5`）；本树实跑 `PARALLEL_TEST_ARTIFACT_DIR=/tmp/deadline-review-entry-AsX7eW bun scripts/parallel-test.ts unit it http` 得 7920 executed、7920 pass、0 fail、45 skipped，故实际值满足该门。字段语义是下限而非精确值：`scripts/validate-entry-evidence.ts:745-759` 仅在 `actualExecuted < baseline.minimum_executed` 时失败，`scripts/capture-entry-evidence.ts:282,294` 也将它作为 `MIN_TESTS`／下限传递。因此 7619 与当前执行数自洽，但不能声称执行数恰为 7619。

## 附加核验

隔离：G1 仅创建并自行触发 timer；G5 的 state 覆盖有 `afterEach` 恢复（`client-request-deadline.it.test.ts:24-30`）；G2 的 live `shutdownAbortWait` 在 `finally` 恢复（`shutdown.unit.test.ts:1131-1153`），且全 backend 同分片实跑 0 fail。新增／改动测试与守卫已按假绿、替身协议、全局 state／timer 泄漏扫描；除上列 2 个 major 外，未发现 blocker 或 major。

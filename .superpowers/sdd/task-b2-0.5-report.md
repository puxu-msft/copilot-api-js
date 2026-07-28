# B2 Task 0.5 实施报告：recovery sink lifetime supervisor

## 状态

DONE。仅完成 Task 0.5；未接入任何 B2 触发路径，生产行为保持不变。提交：`41a351fa`（`feat(pipeline): defer sink settlement across recovery attempts`）。

## 执行清单与验收对照

- [x] 通读 Task 0.5 的“为什么需要”、测试要求与验证清单。
- [x] 核对当前 `ClientSink`、`makeDeliverySseSink`、`createDownstreamDeliverySession` 和近期 delivery/heartbeat 重写。
- [x] TDD RED：先新增失败测试，再写生产实现。
- [x] 所有写方法原样转发：`write`、`writeSynthetic`、`writeKeepalive`、`writeSyntheticEnvelope`、`writeAnchor`。
- [x] 可恢复 heartbeat 控制原样转发：`freezeHeartbeat`、`suspendHeartbeat`、`resumeHeartbeat`。
- [x] attempt-local `close`/`finalize` 被抑制，直到 `settleFinal()`。
- [x] `settleFinal()` 并发及重复调用幂等，只执行一次真实 `close`/`finalize`。
- [x] generation-owned heartbeat 在首次失败与 recovery 之间继续存活，最终 settlement 后计时器归零且不再重启。
- [x] 透明包装保留 `getDownstreamDeliverySession(sink)` 的 WeakMap 身份，避免 driver 写路径退化到 legacy direct-write。
- [x] 零接线：全 `src/` 搜索只有 supervisor 自身定义，没有生产消费者。
- [x] 同步计划 Task 0.5 状态与现状差异。

## 现状与旧 plan 描述的差异

旧 plan 假设可简化为“`close` 停 timer，`finalize` 标终态”，并建议同步 `settleFinal(): void`。当前底座已经重写：

1. `makeDeliverySseSink` 返回 `createDownstreamDeliverySession(...).clientSink`，generation-owned delivery session 独占 heartbeat timer 与终端 fence；raw `makeSseSink` 不再是 pump 看到的最外层 sink。
2. 最外层 `close()` 调 `closeHeartbeat()`：永久停止 generation-owned heartbeat，但不关闭写端口，后续 terminal structural frame 仍可写。
3. 最外层 `finalize()` 返回 `session.terminate({ kind: "complete" })` 的 Promise。`terminate()` 的当前顺序是：状态 `open→terminating`、`closeHeartbeat()`、等待 serializer 中的终端写、状态 `closed`、raw sink `close()`、await raw sink `finalize()`。raw finalize 最终触发 `onDeliveryFinalized`。
4. `freezeHeartbeat()` 已被 2026-07-27 重写为可恢复的 `stopHeartbeat()`，不再永久关闭；`suspendHeartbeat()`/`resumeHeartbeat()` 也是块级可恢复控制。因此 supervisor 不能拦截三者，否则会破坏 buffered/block-level flush 时序；它们全部原样转发。
5. driver 通过 `getDownstreamDeliverySession(sink)` 的 WeakMap 对象身份识别 generation-owned delivery，并据此走 winner/ledger 写路径。旧 plan 未包含这个重写后的隐式能力。supervisor 新对象必须继承内层映射，否则未来 P4/P5 接线时虽字节写出仍可工作，却会静默绕过 generation-owned delivery。为此新增 `inheritDownstreamDeliverySession(source, decorator)`。
6. `settleFinal()` 实现为 `Promise<void>` 而非旧 plan 的 `void`，以等待当前真实异步 finalize、传播终结错误，并用同一 Promise 支持并发幂等。

## 拦截与转发决策

### 被抑制

- `sink.close()`：attempt pump 的 `finally` 会调用它；若转发会永久停掉 generation heartbeat，使 recovery 等待期失去客户端保活。
- `sink.finalize()`：handler 的终结路径会调用它；若转发会进入 delivery `terminate()`、触发 raw finalize 与 `onDeliveryFinalized`，提前封存 History 投递维度并拒绝后续 delivery-session 写。

### 原样转发

- 写方法：`write`、`writeSynthetic`、`writeKeepalive`、`writeSyntheticEnvelope`、`writeAnchor`。
- 可恢复 heartbeat 方法：`freezeHeartbeat`、`suspendHeartbeat`、`resumeHeartbeat`。

### 最终收口

`settleFinal()` 幂等执行 inner `close()`，随后 await inner `finalize()`。显式先 close 与当前 delivery terminate 内部重复 close 都是幂等的；先停 heartbeat 再等待异步 finalize，阻止 finalize 等待 serializer drain 时继续产生 heartbeat。

## 心跳计时器归属结论

生产 delivery sink 的活跃 heartbeat timer 归 `createDownstreamDeliverySession` 所有，不归 raw `makeSseSink` 所有，因为 `makeDeliverySseSink` 会从 options 拆出 heartbeat，只把无 heartbeat 的 `rawOptions` 传给 raw sink，再把 heartbeat 配置交给 delivery session。

测试使用真实 `createDownstreamDeliverySession` + `FakeClock.liveTimerCount`：

- supervisor 收到 attempt-local `close/finalize` 后 live timer 仍为 1；
- 20 秒后真实 heartbeat 写出，随后仍只有 1 个重排 timer；
- `settleFinal()` 后 live timer 为 0；
- 再推进 60 秒仍无新 heartbeat、timer 仍为 0；
- raw `close` 与 raw `finalize` 均恰好一次。

## TDD RED → GREEN

### RED 1：模块不存在

命令：

```sh
bun test tests/pipeline/recovery-sink-supervisor.unit.test.ts
```

结果：0 pass、1 fail；预期失败为 `Cannot find module '~/lib/pipeline/generation/recovery-sink-supervisor'`。

### GREEN 1：核心 supervisor

同命令结果：4 pass、0 fail。覆盖所有写/heartbeat 控制转发、attempt-local terminal 抑制、并发与重复幂等、真实 delivery heartbeat 生命周期。

### Positive control

1. 临时让 wrapper `close/finalize` 直接转发：2 pass、2 fail。抑制测试观察到提前 `close/finalize`，heartbeat 测试观察到 live timer 从预期 1 变 0。
2. 临时移除 `settleFinal` 的 Promise 复用：3 pass、1 fail。幂等测试观察到 close 3 次而非 1 次。
3. 两次均立即恢复实现并重跑绿色。

### RED 2：重写后的 delivery identity seam

新增测试后运行 targeted suite，结果 4 pass、1 fail；预期失败为 `getDownstreamDeliverySession(supervisor.sink)` 收到 `undefined` 而非原 delivery session。

### GREEN 2

新增透明 decorator 映射继承后，supervisor + delivery lifecycle targeted suite 为 21 pass、0 fail。

## 修改文件

- `/home/xp/src/copilot-api-js/.worktrees/upstream-silence-recovery/src/lib/pipeline/generation/recovery-sink-supervisor.ts`：新增 supervisor。
- `/home/xp/src/copilot-api-js/.worktrees/upstream-silence-recovery/src/lib/pipeline/delivery/session.ts`：新增透明 `ClientSink` decorator 的 delivery identity 继承原语。
- `/home/xp/src/copilot-api-js/.worktrees/upstream-silence-recovery/tests/pipeline/recovery-sink-supervisor.unit.test.ts`：新增 5 个 TDD 测试。
- `/home/xp/src/copilot-api-js/.worktrees/upstream-silence-recovery/docs/plan/2026-07-23-upstream-silence-recovery/plan-2-b2-p0-p3-foundation.md`：同步 Task 0.5 完成状态、当前生命周期语义与签名偏离。

未修改 `/home/xp/src/copilot-api-js/.worktrees/upstream-silence-recovery/.superpowers/sdd/progress.md`；该文件在任务开始前已由主会话修改，按用户要求不碰 `.superpowers/` 进度内容。本报告路径由用户明确要求，是唯一例外。

## 验证证据

### Targeted lifecycle

```sh
bun test tests/pipeline/recovery-sink-supervisor.unit.test.ts tests/pipeline/delivery-session.unit.test.ts tests/pipeline/delivery-terminal-race.unit.test.ts
```

结果：21 pass、0 fail、73 expect，3 files。

### TypeScript

```sh
bun run typecheck
```

结果：exit 0，`tsc` 无错误。

### ESLint

```sh
bunx eslint src/lib/pipeline/generation/recovery-sink-supervisor.ts src/lib/pipeline/delivery/session.ts tests/pipeline/recovery-sink-supervisor.unit.test.ts
```

结果：exit 0，0 error；仅出现既有 `baseline-browser-mapping` 数据过旧提示。

### 真实 backend suite

按用户指定替代当前本机失效的 `test:backend` 聚合器：

```sh
bun test --parallel .unit.test .it.test .http.test
```

结果：6514 pass、5 fail，6528 tests、634 files、155.82s。失败均不触及本任务文件：

- `tests/shutdown/shutdown-signals.it.test.ts`：PTY fixture 未见 `READY`；
- `tests/diagnostics/shutdown-barrier.it.test.ts`：5s timeout；
- `tests/history/v3/db-health.it.test.ts`：5s timeout；
- `tests/observability/unknown-endpoint-server.it.test.ts`：Bun worker SIGILL；
- `tests/diagnostics/credential-four-track.it.test.ts`：Bun worker SIGILL。

按用户要求对失败项单跑判别：

```sh
bun test tests/shutdown/shutdown-signals.it.test.ts tests/diagnostics/shutdown-barrier.it.test.ts tests/history/v3/db-health.it.test.ts
```

结果：16 pass、0 fail，4.59s。

```sh
bun test tests/observability/unknown-endpoint-server.it.test.ts tests/diagnostics/credential-four-track.it.test.ts
```

结果：10 pass、0 fail，1.255s。

结论：full parallel 的 5 个失败属于负载/worker 崩溃型既有 flaky，不是本任务回归；新增 supervisor targeted suite 全绿。

### 零行为变化

```sh
rg -n "createRecoverySinkSupervisor|RecoverySinkSupervisor" src --glob '!src/lib/pipeline/generation/recovery-sink-supervisor.ts'
```

结果：无匹配。当前没有生产调用方或触发路径接线。

## 自审

- optional 方法保持 feature-detection 形状：inner 缺失时 wrapper 也为 `undefined`，除 terminal `close/finalize` 必须存在以吸收 attempt cleanup。
- 不吞最终错误：`settleFinal` await inner finalize；rejected Promise 被缓存，后续调用获得同一 rejection，不会重试并双重终结。
- `settleFinal` 并发安全：在 async IIFE 执行前即把 Promise 赋给 `finalSettlement`，第二个同步调用复用同一 Promise。
- heartbeat 无泄漏：真实 delivery session 的 timer 数量与写出均有独立 fake-clock oracle。
- delivery identity 保持：显式测试 WeakMap seam，防未来接线静默退化。
- 范围：只新增基础 primitive、相邻 identity seam、测试与 plan 状态；没有接线、没有修改 handler/driver 行为。

## Concern

1. `ClientSink.finalize` 的类型仍声明 `void`，而当前 production delivery sink 实际返回 Promise。Task 0.5 通过直接 await 调用结果保留运行时异步语义，但类型契约本身仍不诚实。全面把接口改为 `void | Promise<void>` 会波及多个 sink/decorator，超出本 Task；建议 P4/P5 接线前或接线时统一修正，以便调用方获得静态 await 提示。
2. `inheritDownstreamDeliverySession` 是重写后新增的透明 decorator 纪律；现有 `makeReconcilingSink` 没有继承 delivery identity，且已确证默认 Anthropic live 路径受影响，而非“可能”受影响：① `handler-v4.ts:1327` 与 `:1612-1613` 把 `liveReconcilingSink(sink, ...)` 的结果直接传给 `driver.runResponseSink`；② `driver.ts:260` → `runResponseSink:1020` → `maybeRunHedgedResponseSink(...)` → `writeWinnerFrames(sink, ...):971-978` 会对该 decorator 调 `getDownstreamDeliverySession(sink)`；③ 默认 `streamKeepaliveEscalateSec: 200 > 0`，所以 `onDemandEscalation` 成立并令 `anchorHooks` 非 undefined，live 路径默认包装；④ 默认 `generationHedgeEnabled: true` 且 `responseHeaderTimeout: 300`，`runtime-policy.ts:13` 令 hedge 可达；⑤ reviewer 探针实证 `getDownstreamDeliverySession(makeReconcilingSink(...)) === undefined`。因此 hedge 胜者写已走 `for (const frame of frames) await sink.write(frame)` 回退支：字节仍经 decorator 写入 inner delivery 的 serializer 与 ledger，但绕过 `commitWinnerBlock`，丢失 winner 断言与 `candidateId` 归属。该缺陷先于 Task 0.5 存在，不由本 Task 引入；Task 0.5 不改生产接线，已登记 `docs/todo/deferred-backlog.md`，应在 P4/P5 接线或下次修改 sink decorator 时修复。
3. 按角色限制未能派独立 reviewer；已以 TDD、三次 RED、mutation positive control、targeted lifecycle 与全 backend suite 自证。主会话应按项目纪律派 reviewer 做独立审查。

## 2026-07-28 异模型 review Important 闭合

### IMP-1：`settleFinal` 的 async finalize await 守卫

在 `tests/pipeline/recovery-sink-supervisor.unit.test.ts` 新增两条测试：一条让 inner `finalize` 跨真实 `setTimeout` 完成，断言 `settleFinal()` resolve 时异步副作用已发生；另一条让 inner `finalize` 返回 rejected Promise，断言 rejection 由 `settleFinal()` 传播。

Positive control 按 reviewer 指定做了精确 mutation：临时把 `await inner.finalize?.()` 改成 `inner.finalize?.()` 后运行 targeted suite，结果 **5 pass、2 fail**。首条失败为 `finalized` 实收 `false`，第二条既观测到逃逸的 `async finalize failed` unhandled rejection，也观测到 `settleFinal()` 错误地 resolved。恢复 `await` 后同套件 **7 pass、0 fail**。这两条测试因此直接锁住等待语义与错误传播，不再依赖同步 mock 或空 delivery frame 队列。

### IMP-2：`makeReconcilingSink` 的 live delivery identity 缺陷

Concern #2 已从“可能只包裹不走 `getDownstreamDeliverySession` 的 live pump”订正为确证结论，并写入五条证据：两个 handler live 调用点、driver 的 hedge winner 调用链、默认 anchor 包装条件、默认 hedge 可达条件，以及 reviewer 的 identity 探针结果。措辞明确区分：回退支仍把帧写入 inner delivery 的 serializer 与 ledger；实际丢失的是 `commitWinnerBlock` 的 winner 断言与 `candidateId` 归属，不是字节绕过 delivery。

同一缺陷已按活文档格式登记到 `docs/todo/deferred-backlog.md`，包含根因/现状、当前行为、理想架构与两种修复形状、暂缓原因、触发条件和发现方。本轮遵守 Task 0.5 边界，没有修改 `makeReconcilingSink` 生产代码。

### Minor 注释

`recovery-sink-supervisor.ts` 已补明 `close`/`finalize` 无条件定义的原因：即使 inner 缺少对应方法，也必须吸收 attempt cleanup，不能让 optional call 穿透到 inner 生命周期。identity 继承注释也已收紧为准确行为：回退仍进 delivery，但丢失 winner 断言与 `candidateId` 归属。

### 闭合验证

- `bun run typecheck`：exit 0，`tsc` 无错误。
- `bunx eslint src/lib/pipeline/generation/recovery-sink-supervisor.ts tests/pipeline/recovery-sink-supervisor.unit.test.ts`：exit 0，0 error；仅有既有 `baseline-browser-mapping` 数据过旧提示。
- `bun test tests/pipeline/recovery-sink-supervisor.unit.test.ts`：7 pass、0 fail、17 expect。
- `bun test --parallel tests/pipeline/`：830 pass、0 fail，104 files。

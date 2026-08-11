# History Worker Batch 1a 第二轮整改复审

> 状态：通过。评审对象为 `fb3a969d3a814671712eb790716a13e37a263604..9e5ab5a2fec68a24dec263439fa4035a03e9b0ee`，评审者为恢复原 transcript 的 reviewer `acf499466aa10c311`。本文转录 reviewer 的最终结构化结果；本会话的独立实测记录见 `docs/tmp/2026-08-07-history-worker-progress-impl-1.md`。

## 结论

- `blocker=0`
- `major=0`
- spec compliance：PASS
- code quality：PASS
- reviewer 在目标 Batch 1a worktree 运行 fast：5057 pass／0 fail。

## 逐项复核

- **C1 PASS——throw-before-callback 不再永久占用 reservation。** `src/lib/history/worker/admission.ts:146-162` 捕获 sink throw 后经同一 `onOutcome("failed")` 立即释放；`tests/history/worker/admission.unit.test.ts:141-167` 证明 outcome 为 `failed` 且下一 waiter 获准。
- **C2 PASS——throw 后迟到 callback 不会二次结算。** `src/lib/history/worker/admission.ts:147-153` 的 settlement guard 在释放前设置 `done=true`；`tests/history/worker/admission.unit.test.ts:169-209` 覆盖 callback-before-throw、late callback 与 throw-after-callback，均无双释放或结果反转。
- **C3 PASS——默认未配置 sink 自身遵守 no-throw 契约。** `src/lib/history/worker/registry.ts:18-23` 同步且恰一次回调 `failed`；`tests/history/worker/registry.unit.test.ts:56-77` 证明无 wedging 且 `sinkEnqueueErrorsTotal=0`。
- **C4 PASS——runtime 共用同一 sink 契约。** `src/lib/history/worker/runtime.ts:42-50` 继承 `HistoryTerminalSink`；`src/lib/history/worker/runtime.ts:118-138,203-211,373-400` 将无 transport、校验／发送异常与 callback 异常收口而不向 `enqueue()` 调用者抛出，聚焦回归全绿。
- **C5 PASS——pause→close 旧 major 未回归。** `src/lib/history/worker/admission.ts:181-217` 保持 pause waiter 全量 reject，`resume()` 不得复活已关闭 controller；相关测试位于 `tests/history/worker/admission.unit.test.ts:291-330`。
- **C6 PASS——正确 sink 正路径仍成立。** `tests/history/worker/admission.unit.test.ts:120-139,212-229` 覆盖 pending→messageId→terminal outcome，未因 fail-closed 防御而破坏正常结算。
- **C7 PASS——修法符合冻结 replay 边界。** 冻结 spec `docs/spec/2026-08-06-history-persistence-worker.md:159-163` 要求已进入 runtime pending 集合的 Worker crash envelope 重放；plan `docs/plan/2026-08-07-history-persistence-worker.md:461-481` 把 restart／replay 归 runtime、reservation 归 admission。没有冻结契约要求对违反 no-throw 端口契约的 sink 自动重投；当前 fail-closed 边界不削弱后续 runtime generation replay。

## 最终裁决

未发现 blocker／major，整改设计成立，Batch 1a 可合入 `master`。

转录完成后，同一 reviewer 再次读取本文与进度文件并确认：“转录准确，状态一致”。

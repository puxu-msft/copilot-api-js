# RequestEnvelope 作用域重构契约评审

评审范围：`master` 中的 commit `69bea99787ae1d6e64ff4f417f5f00f0d463ae61`，聚焦七条破坏性契约及 hedge／retry／记录冻结接缝。

已读取／执行的证据：逐文件读取该 commit 的 `envelope.ts`、`driver.ts`、四个 codec、candidate-state、cell 及 operation record；与父提交比对旧 `requestState` 的四个赋值点和新 `legSupplyReady` 的四个赋值点；运行当前 `master` 的 focused tests：`tests/pipeline/candidate-state.unit.test.ts`、`tests/pipeline/hedged-driver.it.test.ts`、`tests/pipeline/hooks/client-inbound.unit.test.ts`、`tests/context/model-operation-record.unit.test.ts`、`tests/responses/responses-v4.http.test.ts`、`tests/responses/responses-fallback.http.test.ts`。注意当前 HEAD 为 `2bbefdaf`，测试只能佐证未被随后路径改动影响的现状；以下发现直接锚定目标 commit 源码。

总体 verdict：修复 major 后可进入下一阶段。blocker 数量：0。

事实性发现：

[major] `src/lib/pipeline/driver.ts:699-705` — 生产 candidate fork 丢弃 `candidateStateFactory.fork()` 返回的 `fork.body`，改把 `env.attempt.body` 的同一引用塞给每个 `forkEnvelope`。
证据：`candidate-state.ts:54,72-75` 明确逐 candidate `cloneValue` body，但 driver 仅取 `fork.candidate`，而 `runResponseSink` 在 `driver.ts:1091-1097` 将 primary 的 `env` 传给 `runHedge`，故 primary 与 hedge 的 `attempt.body` 引用相同。
错误状态会通过：任一 hedge 路径对 body 的嵌套就地写会污染兄弟的 wire；这直接违反变更 3，也使变更 1 的“candidate 独占 attempt”不能成立。
正确状态也能通过：`tests/pipeline/candidate-state.unit.test.ts:67-75` 只验证 factory 产物独立，focused tests 全绿，但生产桥接绕过该产物的 body；因此这是 false-green 而非 test 已覆盖的正确性。
修复：在 `forkEnv` 使用当前 attempt 的 `structuredClone(env.attempt.body)`，或将“从当前 attempt 克隆”的责任收敛进 factory 并让 driver 使用其 body；补一条真实 driver hedge 测试，同时断言 primary／hedge body 身份不同及一侧嵌套写不影响另一侧。

主观建议：无。

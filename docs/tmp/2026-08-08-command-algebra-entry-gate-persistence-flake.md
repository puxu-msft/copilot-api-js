# Commit -1 entry gate persistence timing failure

## 失败与根因

在 `90e777bc1b42eef2738e12abfff487f9ac7c97ef` 上运行 `bun run test:backend`，`tests/restart/states-flush-freeze.it.test.ts` 先后在 calibration 与 feature-negotiation 的解冻后落盘断言失败。两处实现均以 timer 触发 serialized async writer；旧测试只等待 debounce 加 100～200ms 后直接读盘，因此并行负载可让 timer 或异步原子写尚未完成。目标文件单跑 3× 为 18 pass／0 fail，不能据此把 full-suite 失败忽略为既有 flaky。

## 既有 guard 守护的不变量

`tests/infra/resetters-complete.unit.test.ts` 守护：`src/` 与 `packages/*/src/` 下每个 `*ForTest(s|ing)` 导出，必须登记进统一 `RESETTERS`，或在 `EXEMPT` 中逐项说明为何不是独立 resetter。依据是该文件头部的 L1 completeness contract 与 `EXEMPT` 表；放宽枚举或通过改名躲开 regex 会让新增 module-global reset 静默漏登记，因此不采用。

## 本次处置

两个新 hook 只取消并执行模块已经持有的 debounce timer，并返回是否真的存在 pending timer；它们不新增 module-global 状态，且两个既有 resetter已经负责取消各自 timer。故使用唯一的领域化名称 `drainScheduledCalibrationPersistenceForTests` 与 `drainScheduledNegotiationPersistenceForTests`，并在 `EXEMPT` 中逐项登记为 action hook，而不是把它们错误加入 per-test reset loop。

测试对未冻结路径要求 hook 返回 `true` 并核对磁盘内容，对 frozen 路径要求返回 `false` 并核对磁盘未变化。两模块分别注入“freeze 后仍安排 timer”的 exact mutation 时，测试均以 `Expected: false / Received: true` 在目标机制处转红；恢复后 10× 为 60 pass／0 fail。

新 action hook 的名称仍匹配 resetter completeness guard 的 `*ForTest(s|ing)` 枚举；没有靠改名躲门。`tests/infra/resetters-complete.unit.test.ts` 的 `EXEMPT` 逐模块记录：hook 只消费已有 timer，reset 仍由既有 resetter 拥有。该 guard 实跑 3 pass／0 fail。

最终 `bun run typecheck` 退出 0；`bun run test:backend` 为 16 shards、6733 tests、6733 pass、0 fail、7258 executed、30 skipped。数字口径是本修复 worktree 在 `90e777bc` 加当前未提交修复 diff 上的单次运行，不外推为其它 commit 的永久基线。

## 验收

- `bun test tests/restart/states-flush-freeze.it.test.ts --rerun-each=10`
- `bun test tests/infra/resetters-complete.unit.test.ts`
- `bun run typecheck`
- `bun run test:backend`
- 独立 reviewer 同时检查错误状态能否通过与正确状态能否通过，并裁定两个 `EXEMPT` 是否保持 guard 原不变量。

# retry-strategy registry — subagent-driven 进度 ledger

Worktree: /home/xp/src/copilot-api-js/.worktrees/retry-registry  (branch feat/retry-strategy-registry)
Plan: docs/plan/2026-07-21-retry-strategy-registry.md
RFC:  docs/rfc/2026-07-21-retry-strategy-registry.md
BASE (分支起点): 6b7756deda0dede3a1ff74df42c1ef2995421836
执行:隔离 worktree + 独立分支;每 task 派 gpt-souls:implementer + 逐 task 审;golden 逐 commit gate;pathspec 提交。

## 任务状态
- [x] Task 1 (Commit 1): golden 预捕全 6 cell — complete (commit 12c0b532, self-verified: 真过/非空/真工厂名/有效 oracle/clean). NOTE: plan 骨架 effort-learning name 笔误(真名 "effort-learning" 非 "-retry"),Task6 doc-sync 修
- [x] Task 2 (Commit 2): retry-registry.ts — complete (commit 33d987f0, reviewer: spec ✅ + 质量 approved, 0 Critical/Important). Minor→Task6: ① throwMissing 第3处再抽共享 util ② Task2单测 import Task1 golden 的 ANTHROPIC_16_NAMES 防漂移 ③ plan Task1 示例代码块 effort-learning-retry 笔误改 effort-learning ④ 确认 label 接到日志点
- [x] Task 3 (Commit 3): 三 leg 委托 assembler — complete (commit 1ad16ede, reviewer: spec ✅ + 质量 approved, 0 blocker). golden 6/6 逐字节过=字节等价;attemptRef 共享经 reviewer 探针+结构双验保留. → Task4 补 attemptRef 共享回归测试(建议2);→ Task6: label 死字段删评估 + 13处 payload cast 分组类型评估(RFC §3.1 备选)
- [x] Task 4 (Commit 4): config retry.strategies 开关 + allow+warn + attemptRef 共享回归测试 — complete (schema.ts RETRY_STRATEGY_CONFIG_KEYS 内联16键+partialRecord;state.ts retryStrategies 9处 grep -c 对账;三 build 函数接回 state.retryStrategies;config.ts warnDisabledSharedRetryStrategies;retry-strategies.it.test.ts 11 pass + config-hot-reload EXEMPT 1条 + retry-registry.unit.test.ts 新增 attemptRef 回归2条;golden 6/6 仍过;四格式 2145 pass;test:fast 4358 pass(基线4356+2);typecheck 绿;eslint --fix 后重验)
- [x] Task 5 (Commit 5): telemetry fire 计数 + 注册集诊断 — complete (efbc0926, reviewer: spec ✅ + 质量 approved, 偏离(独立模块非并入 registry)经核实背书, 0 blocker). gpt-souls provider 抖动连挂4次全 resume 无换模型. → Task6 doc/backlog: /metrics HELP 补范围收窄说明; counter 无维度记 backlog; docs/API.md 补 retryStrategyRegistry + retry_strategy_fires_total
- [x] Task 6 (Commit 6): 去重收口 + doc-sync — complete. import 去重 Task3 已提前完成(核实无残留);`RetrySemanticsSpec.label`/`OpenAiCcStrategiesDeps.label`/`RetryStrategyDeps.label` 死字段确认删除(8文件机械单行删);ANTHROPIC_16_NAMES/SHARED_3_NAMES 三处重复抽 tests/helpers/retry-strategy-names.ts;plan Task1 笔误修+/metrics HELP 补范围+DESIGN/API.md doc-sync+RFC状态注landed;SHARED_RETRY_STRATEGY_CONFIG_KEYS parity测试当场补做(低成本无取舍);剩2项(13处cast分组/attemptRef日志脆性/retry-fire维度)记 deferred-backlog;golden 6/6仍过;3905 pass 0 fail;test:backend 6058 pass 4 fail(History V3 pre-existing,stash验证同基线同失败);typecheck绿;eslint --fix后重验绿

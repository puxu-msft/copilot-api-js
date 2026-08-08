---
name: methodology-false-red-from-process-global-quantities-not-the-mechanism
description: 分片/并发下反复出现的随机 false-red，根因常是判据挂在与被测机制无关的进程全局量上（全局 timer 集合、wall-clock 预算）；解药是把 oracle 换成直接观测目标机制、或按机制重设预算，而不是逐条打地鼠
metadata:
  type: feedback
---

**分片或并发下出现「单文件跑绿、全套件随机红」时，先问这条判据观测的是不是被测机制本身**——最常见的根因不是污染，而是**判据挂在一个与该机制无关的进程全局量上**，于是别的模块动了那个量就把它染红。同一天在本项目撞到两种形态：

- **全局 timer 集合当 retry oracle** —— `tests/pipeline/driver.unit.test.ts` 的四个 408 负样本用 `FakeClock.liveTimerDelaysMs` 为空来证明「没有重试」。单文件 55/55 绿；排在 `anthropic-models.http` 的 `useIsolatedRuntime()` 之后就红，因为 fixture 异步注册了一个无关的 1000ms 全局 timer。被测机制是 driver 的重试决策，而「全进程此刻有没有 timer」不是它。
- **wall-clock 预算当通过条件** —— `tests/infra/validate-entry-evidence.unit.test.ts` 的 43 个用例几乎每条都 fork 真实 validator 跑真实 git fixture，单文件独跑 45.4 秒、最慢用例 4.56 秒。Bun 默认 5 秒 per-test 超时在 16-shard 负载下每轮随机把 1～2 条判超时（实测 7.3／9.5／7.4 秒），而这些用例守的是 provenance／dependency-integrity fail-closed，跟耗时毫无关系。

**Why:** 这类红**看起来完全像真回归**——它指着一个真实存在的用例、给出一条真实的失败信息，而且换一轮又换一条，很容易被诊断成「污染」或「flaky」然后逐条加 timeout／加清理。逐条打地鼠一定失败：我修完两条之后第三条又红了，因为染红的量是全局的，红在哪一条只取决于那一轮的调度。

**How to apply:** 症状是「随机某条红、单跑全绿、修完一条换一条」时，别先找污染源，先对红的那条问：**这条断言在目标机制被改坏时会红吗？在目标机制完全正确时会不会也红？**（`criteria-fail-two-ways` 的两个方向都要问）

- 判据引用了**进程全局集合**（timer 表、handle 数、监听器数、全局计数器）→ 换成直接观测目标机制的 oracle。driver 那例换成五项：constructor identity、`classifyError` 结果、attempt 计数、`recordAttemptFailure` 记录、原错误 rejection——都只看 driver 自己的决策。
- 判据是 **wall-clock 预算**且被测机制与时间无关 → 按该文件的真实机制**设文件级预算**（`setDefaultTimeout(30_000)`），别逐条加 `test(name, fn, timeout)`：后者是打地鼠，而且把单表达式 `test()` 改成多行会连带触发一片 prettier 报错。先量出实际耗时分布再定预算，别拍脑袋。
- **改既有 guard 前先落盘记录**它守的不变量、依据、本次处置与级别（user-rule `63-engineering-practice` 的 `red-tests-may-be-guarding-something`）——把「判据没有鉴别力」和「实现真的坏了」分清楚，判断本身要留痕，因为你既是判官又是被告。

实证：2026-08-08 无损 shutdown 评审整改期间，两处处置记录在 `docs/tmp/2026-08-08-lossless-shutdown-review-dispositions.md`「既有测试 guard 处置记录」两节，耗时原始数据在 `docs/tmp/2026-08-08-validate-entry-evidence-timings.xml`。相关：[[reference-bun-test-parallel-breaks-single-process-superlinear-degradation]]（分片 runner 本身）、[[methodology-full-suite-red-classify-before-pollution-playbook]]（先分类再套污染 playbook）、[[reference-elapsed-time-test-inject-clock-seam-not-setsystemtime]]（时间相关测试的正确 seam）。

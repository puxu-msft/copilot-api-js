# 04-v2-flaky-timing 审查 1

日期：2026-03-28

审查对象：[04-v2-flaky-timing.md](/home/xp/src/copilot-api-js/docs/restructure/04-v2-flaky-timing.md)

## 结论

该文档**有价值，但当前不能直接执行**。

它正确识别了一部分“固定等待后再断言”的脆弱测试，但也混入了几类并不适合按 `waitUntil` 改造的场景，且部分迁移示例依赖当前并不存在的测试接口。

## 主要发现

### 1. `system-prompt-config-integration.test.ts` 被误判

文档将 [`tests/unit/system-prompt-config-integration.test.ts:223`](/home/xp/src/copilot-api-js/tests/unit/system-prompt-config-integration.test.ts#L223) 描述为“等待 config 热重载生效”，这一判断不符合代码实际。

实际测试流程是：

- 写入第一次 config
- 调用 `loadConfig()`
- `setTimeout(50)` 拉开文件 mtime 差距
- 再次写入 config
- `resetConfigCache()`
- 再次 `loadConfig()`

这里的 `setTimeout(50)` 不是为了等待后台异步状态传播，而是为了确保文件修改时间可区分。  
如果按文档改成 `waitUntil(state 已更新)`，会把一个“文件时间戳粒度 / 缓存命中”问题错误改造成“状态轮询”问题。

建议：

- 将该项从“改为 waitUntil”清单移出
- 单独标记为“mtime/缓存粒度问题，不属于 flaky waitUntil 改造”

### 2. `AdaptiveRateLimiter` 迁移方案依赖不存在的公开属性

文档在示例和迁移清单中使用了：

- `limiter.queueSize`
- `limiter.mode`

但当前 [`AdaptiveRateLimiter`](/home/xp/src/copilot-api-js/src/lib/adaptive-rate-limiter.ts) 并未公开这两个属性。当前公开观察入口只有 [`getStatus()`](/home/xp/src/copilot-api-js/src/lib/adaptive-rate-limiter.ts#L490)。

因此文档以下写法并不是现成可执行方案：

- `waitUntil(() => limiter.queueSize > 0, ...)`
- `waitUntil(() => limiter.mode === "rate-limited", ...)`

建议：

- 将迁移目标改为：
  - `waitUntil(() => limiter.getStatus().queueLength > 0, ...)`
  - `waitUntil(() => limiter.getStatus().mode === "rate-limited", ...)`
- 不要再写成“需确认”，应直接改成当前代码可执行的方案

### 3. `shutdown.test.ts` / `stream-shutdown-race.test.ts` 在文档中前后定性不一致

文档先把这些文件列进“受影响文件”，暗示它们属于 flaky fixed-delay 问题：

- [`tests/component/shutdown.test.ts`](/home/xp/src/copilot-api-js/tests/component/shutdown.test.ts)
- [`tests/integration/stream-shutdown-race.test.ts`](/home/xp/src/copilot-api-js/tests/integration/stream-shutdown-race.test.ts)

但后面又在“保留原样”部分承认它们属于“模拟延迟事件”而不是“等待状态”。

按代码实际看，后者更准确。例如：

- [`tests/component/shutdown.test.ts:110`](/home/xp/src/copilot-api-js/tests/component/shutdown.test.ts#L110) 的 `setTimeout(() => tracker._clearRequests(), 30)`
- [`tests/integration/stream-shutdown-race.test.ts:134`](/home/xp/src/copilot-api-js/tests/integration/stream-shutdown-race.test.ts#L134) 的 `setTimeout(() => controller.abort(), 50)`

这些定时器是在制造事件发生顺序，不是“先睡 N 毫秒再断言某状态”。

建议：

- 将这两组测试从“受影响文件”主表移出
- 保留在“明确不改”的说明里即可

### 4. 文档的验证口径过大，和实际范围不一致

文档最后写了：

- “无新增固定延时 sleep”

但当前仓库仍存在多处固定等待，且没有被纳入此文档范围，例如：

- [`tests/e2e-ui/vuetify-models.pw.ts:57`](/home/xp/src/copilot-api-js/tests/e2e-ui/vuetify-models.pw.ts#L57)
- [`tests/e2e-ui/vuetify-dashboard.pw.ts:85`](/home/xp/src/copilot-api-js/tests/e2e-ui/vuetify-dashboard.pw.ts#L85)
- [`tests/e2e-ui/legacy-pages.pw.ts:10`](/home/xp/src/copilot-api-js/tests/e2e-ui/legacy-pages.pw.ts#L10)

因此当前文档要么：

- 明确范围只覆盖 Bun 单测 / component / integration tests

要么：

- 把 Playwright 固定等待也纳入同一治理文档

否则“无新增固定延时 sleep”这个验证条件并不严谨。

## 文档中成立的部分

以下判断是有价值的，建议保留：

- [`tests/unit/rate-limiter-shutdown.test.ts`](/home/xp/src/copilot-api-js/tests/unit/rate-limiter-shutdown.test.ts) 的两段固定等待确实是在猜测队列/重试状态何时建立
- [`tests/component/rate-limiter.test.ts:348`](/home/xp/src/copilot-api-js/tests/component/rate-limiter.test.ts#L348) 的 `Bun.sleep(50)` 确实属于脆弱等待
- [`tests/component/context-manager.test.ts:189`](/home/xp/src/copilot-api-js/tests/component/context-manager.test.ts#L189) 的 60ms 相对 50ms 阈值余量过小，属于典型时序敏感点
- [`tests/unit/error-persistence.test.ts:71`](/home/xp/src/copilot-api-js/tests/unit/error-persistence.test.ts#L71) / [`tests/unit/error-persistence.test.ts:200`](/home/xp/src/copilot-api-js/tests/unit/error-persistence.test.ts#L200) 的固定等待确实适合改成“等文件写完”

## 建议修改方向

建议把原文档收敛为下面三类：

### A. 应改为 `waitUntil`

- `rate-limiter-shutdown.test.ts`
- `rate-limiter.test.ts`
- `context-manager.test.ts`
- `error-persistence.test.ts`

### B. 不属于 `waitUntil` 改造

- `system-prompt-config-integration.test.ts`
  - 原因：这是 mtime/缓存问题，不是状态传播等待

### C. 故意模拟延迟事件，保留原样

- `shutdown.test.ts`
- `stream-shutdown-race.test.ts`

## 最终判断

`04-v2-flaky-timing.md` 目前不是“错误文档”，但它还处在“方向正确、执行边界不够准”的状态。

在修正文档中的 3 个问题后，它才适合作为直接执行的任务说明：

1. 移除对 `system-prompt-config-integration.test.ts` 的误判
2. 把 `AdaptiveRateLimiter` 示例改成基于 `getStatus()`
3. 收窄验证口径，避免与 Playwright 固定等待范围混淆

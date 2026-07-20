# 04-v2-flaky-timing 审查 2

日期：2026-03-28

审查对象：[04-v2-flaky-timing.md](/home/xp/src/copilot-api-js/docs/restructure/04-v2-flaky-timing.md)

## 结论

相较于上一版，文档已经明显收敛，**大部分关键误判已修正**：

- 已明确范围只覆盖 Bun 测试
- 已移除对 `system-prompt-config-integration.test.ts` 的错误归类
- 已将 `AdaptiveRateLimiter` 的迁移方案改为基于 `getStatus()`
- 已将 `shutdown.test.ts` / `stream-shutdown-race.test.ts` 正确归类为“模拟延迟事件，保留原样”

当前文档已接近可执行，但还有 2 个问题需要修正。

## 新发现

### 1. 范围声明与迁移清单仍不完全一致

文档声明范围覆盖 Bun 运行的：

- unit
- component
- integration
- e2e

但当前清单遗漏了 [`tests/component/context-manager.test.ts:236`](/home/xp/src/copilot-api-js/tests/component/context-manager.test.ts#L236) 的固定等待：

```ts
await Bun.sleep(20)
```

该等待不属于：

- Playwright 范围外文件
- 故意模拟延迟事件（如 `setTimeout(() => abort(), N)`）
- mtime/缓存粒度问题

因此，它应当被纳入文档范围，至少需要在文档中显式说明为什么不处理；否则范围定义与迁移清单不一致。

建议：

- 在 A 类或单独说明中补上 `context-manager.test.ts:241`
- 若认为该处不应改，也应在文档中明确理由

### 2. `rate-limiter-shutdown.test.ts` 第二段等待描述仍不准确

文档当前写法：

- `setTimeout(r, 100)` 等待 reject 完成
- 评估是否仍需要等待

但代码实际行为是：

1. 第一请求触发 rate-limited mode
2. 第二请求发起
3. `await new Promise((r) => setTimeout(r, 100))`
4. 调用 `rejectQueued()`

因此第二段等待的语义不是“等待 reject 完成”，而是：

- 等待第二个请求真正进入 queue
- 确保 `rejectQueued()` 调用时有对象可拒绝

相关代码见：
- [`tests/unit/rate-limiter-shutdown.test.ts:41`](/home/xp/src/copilot-api-js/tests/unit/rate-limiter-shutdown.test.ts#L41)

建议：

- 将该项描述改为“等待第二个请求入队”
- 迁移方向应与第一段类似，改为基于 `limiter.getStatus().queueLength`

## 本轮确认已修正的问题

以下是上一轮 review 指出、当前已被文档修正的点：

- `system-prompt-config-integration.test.ts` 不再被错误归为 `waitUntil` 改造对象
- `AdaptiveRateLimiter` 不再使用不存在的 `queueSize` / `mode` 属性
- `shutdown.test.ts` / `stream-shutdown-race.test.ts` 不再被混放进“应改”清单
- 验证口径已收窄，不再错误覆盖 Playwright E2E

## 最终判断

当前文档已经接近可直接执行，但还不能算完全准确。

还需要补完这 2 点：

1. 处理 `context-manager.test.ts:241` 的遗漏
2. 修正 `rate-limiter-shutdown.test.ts` 第二段等待的语义描述

修完后，这份文档就可以作为执行说明继续推进。

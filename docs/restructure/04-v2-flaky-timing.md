# 04-v2 — 消除时序敏感测试的固定延时

## 范围

仅覆盖 Bun 运行的测试（unit / component / integration / e2e）。
Playwright 浏览器 E2E（`tests/e2e-ui/*.pw.ts`）不在本文档范围。

## 问题

部分测试依赖固定延时 sleep 等待异步状态转换。
在高负载或 CI 环境下，调度器可能未在预期窗口内执行回调，导致间歇性失败。

## 方案：`waitUntil` 辅助函数

在 `tests/helpers/wait-until.ts` 中新增：

```ts
/**
 * Poll a condition until it returns true, or timeout.
 * Replaces fixed-delay sleeps in timing-sensitive tests.
 */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  opts: { timeout?: number; interval?: number; label?: string } = {},
): Promise<void> {
  const { timeout = 2000, interval = 10, label = "condition" } = opts
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`waitUntil timed out after ${timeout}ms waiting for: ${label}`)
}
```

## A. 应改为 waitUntil

| 文件 | 行 | 当前写法 | 改为 |
|------|------|----------|------|
| `rate-limiter-shutdown.test.ts` | 40 | `setTimeout(r, 200)` 等待 re-enqueue | `waitUntil(() => limiter.getStatus().queueLength > 0)` |
| `rate-limiter-shutdown.test.ts` | 46 | `setTimeout(r, 100)` 等待 reject 完成 | 评估是否仍需要等待 |
| `rate-limiter.test.ts` | 348 | `Bun.sleep(50)` 等待 rate-limited mode | `waitUntil(() => limiter.getStatus().mode === "rate-limited")` |
| `context-manager.test.ts` | 189 | `Bun.sleep(60)` 等待 maxAge=0.05s 过期 | `waitUntil(() => Date.now() - startTime > 50)` |
| `error-persistence.test.ts` | 71, 200 | `Bun.sleep(50)` 等待 async write | `waitUntil(() => existsSync(targetFile))` |

## B. 不属于 waitUntil 改造

| 文件 | 行 | 原因 |
|------|------|------|
| `system-prompt-config-integration.test.ts` | 223 | `setTimeout(50)` 是为了拉开文件 mtime 差距，确保缓存失效检测正确。这是 mtime 粒度问题，不是异步状态传播等待 |

## C. 模拟延迟事件，保留原样

以下 `setTimeout` 是故意制造事件发生顺序（"N 毫秒后触发某动作"），不是"sleep 后检查状态"：

| 文件 | 行 | 用途 |
|------|------|------|
| `shutdown.test.ts` | 110, 201, 217, 311 | `setTimeout(() => tracker._clearRequests(), 30)` 模拟请求延迟完成 |
| `shutdown.test.ts` | 228 | `setTimeout(() => abortController.abort(), 20)` 模拟延迟 abort |
| `stream-shutdown-race.test.ts` | 134, 159, 174, 189 | `setTimeout(() => controller.abort(), N)` 模拟延迟 abort |

## 验证

- [ ] `waitUntil` 创建在 `tests/helpers/wait-until.ts`
- [ ] A 类文件全部迁移
- [ ] `npm run test:all` 连续 5 次全绿

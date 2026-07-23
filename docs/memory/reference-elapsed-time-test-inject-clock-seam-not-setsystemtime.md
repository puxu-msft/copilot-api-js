---
name: reference-elapsed-time-test-inject-clock-seam-not-setsystemtime
description: 测「墙钟总耗时/elapsed」逻辑注入 clock seam，别用 bun setSystemTime——后者跨 async await 不冻结、且绝对时基与真实 startedAt 相减出负值
metadata: 
  node_type: memory
  type: reference
  originSessionId: 63578415-5402-47b6-b095-a865ae0456a3
  modified: 2026-07-22T21:10:49.656Z
---

给一段「累计墙钟耗时超阈值就停」的逻辑写确定性单测时，**别用 bun `setSystemTime`**，改在被测函数上暴露一个 clock seam（`now?: () => number`，默认 `Date.now`），测试注入确定性计数器。

**踩坑实测（DI-5-followup-2 `runWithTransientRetry` 的 `maxTotalMs` 墙钟 cap）**：被测循环入口 `const startedAt = Date.now()`，check 为 `Date.now() - startedAt + backoffMs > maxTotalMs`。两种 setSystemTime 写法都给出错误计数：
- 在 attempt 回调里 `setSystemTime(new Date(calls*1000))`：设的是**绝对 epoch**（≈1970），而 `startedAt` 是循环入口捕获的**真实当前时刻**（≈2026 的巨大值）→ `now - startedAt` 恒为大负数 → cap 永不触发 → `attempts` 跑满 maxAttempts=100（期望 4，received 100）。
- `setSystemTime(new Date(0))` 想「冻结」在 0：**跨 `await`（abortableDelay 让出事件循环）后 Date.now() 并不稳定冻结**，第 3 次迭代 elapsed 已 >0，令恰好等于 cap 的边界（backoff=3000, cap=3000）提前触发 → received 3 而非 4。

**正解**：`now = opts.now ?? Date.now`，seam 默认生产走真钟、drain 调用处不传 `now`；测试传 `fakeClock(step)`（首读=startedAt 返 0、之后每读 +step，模拟「慢 attempt」自身阻塞）或 `() => 0`（冻结、只验预测项）。确定、可复现、还能建模 attempt 自身阻塞耗时——这正是 reviewer 关注的 SQLite busy_timeout wedge，setSystemTime 那套建模不出来。镜像本仓既有 `setAbortableDelayScaleForTests` scale seam 思路。

姊妹坑：边界值别设成恰好等于 cap（backoff==maxTotalMs），真实钟下任意正 elapsed 都会把 `elapsed+backoff>cap` 顶穿、使计数在冻结钟单测与真实钟 it-test 之间不一致；it-test 用留足余量的边界（如 cap=2500 vs backoff=1000）。相关：[[project-request-lifecycle-cancel-settle-quiesce]]、skill `bun-node-runtime-gotchas`。

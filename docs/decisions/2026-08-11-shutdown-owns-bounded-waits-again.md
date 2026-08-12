# ADR: shutdown 重新拥有自己的墙钟界（`graceful_wait` / `abort_wait`）

- **状态**：Accepted
- **日期**：2026-08-11
- **裁决人**：用户（本会话直接裁决，原话：「graceful 600s + abort 60s 写入默认配置，然后实现他们」）
- **相关**：**推翻** [2026-08-10-three-tier-shutdown-signal-contract](2026-08-10-three-tier-shutdown-signal-contract.md) 与 [spec/2026-08-07-lossless-graceful-shutdown-drain.md](../spec/2026-08-07-lossless-graceful-shutdown-drain.md) 共同确立的不变量「**shutdown 不以任何固定时间值终止 operation**」；[lifecycle.md](../lifecycle.md)「优雅关闭」；skill `process-lifecycle-shutdown`

## 背景：被推翻的是哪一条，以及它当初为什么立

2026-08-07 的 incident 里三个正常工作的长请求在同一秒被 `Server is shutting down` 杀掉：`graceful_wait`（当时配 300s）到期后，shutdown 用一个**进程级 `AbortSignal`** 中止了所有剩余 operation。随后的无损排空改造删掉了 `shutdown.graceful_wait`、`shutdown.abort_wait` 与整套自动 abort 设施，并立下上述不变量；2026-08-10 的三档信号契约在其上补回了「有界」——但把界交给**操作者**（第二次 Ctrl+C），shutdown 自己仍不持有任何时限。

## 决策

**shutdown 重新拥有两个默认开启的墙钟界**，bundled 配置为 `shutdown.graceful_wait: 600`、`shutdown.abort_wait: 60`。

## 为什么这不是回到 2026-08-07

**当初有害的是「到点之后做什么」，不是「有没有到点这回事」。** 这一点是本裁决全部合理性的支点：

| | 2026-08-07 的行为 | 本裁决的行为 |
|---|---|---|
| 到点的动作 | 进程级 `AbortSignal.abort()` | `abandonDrain()` —— 与操作者第二次 Ctrl+C **完全相同**的请求级原语（`reapInFlight()` + `fail()`） |
| 记录 | 丢失：请求以 `Server is shutting down` 死在建 `RequestContext` 之外 | 保留：终态带归因落盘，随后照常走完 finalize，History／Telemetry／Diagnostic 全部 flush |
| 归因 | 无 | `shutdown` / `graceful-wait-elapsed`（与操作者路径的 `operator-abandoned-drain` **刻意不同码**） |

被删掉的 `shutdownAbortController` / `getShutdownSignal()` **没有复活**，本轮没有引入任何进程级 abort。

## 两个界的确切语义

- **`graceful_wait`（600s，0 = 无限等）**：从**认领 lifecycle 那一刻**起计，而不是从 drain 循环起计。这是刻意的——`drainAdmissionHandoffs` 与交接 freeze 跑在 drain 之前、同样无上界，且**此前没有任何一档能够到它们**（第二档在那里发现 `activeDrainSource` 为 null，只能如实报告自己帮不上）。到点执行无损放弃排空。
- **`abort_wait`（60s，0 = 无限等）**：**从「排空被放弃」那一刻开始计**。通常那是 `graceful_wait` 到点；**运维手动按第二次终止信号同样立刻启动它**（并取消尚未到点的 `graceful_wait`）。逃的是持久化 barrier 本身，因此**不落盘**——语义等同第三档信号。因此 `graceful + abort` 是**最坏情形**的总界，不是固定时刻表。
- **顺序不变量**：进程自己的总界 = `graceful_wait + abort_wait`（当前 660s）。任何进程管理器的上限必须**大于**这个和，否则会在无损 flush 中途 SIGKILL、正好毁掉这一档存在的意义。`contrib/systemd` 的 `TimeoutStopSec` 已由 `infinity` 改为 `900`；pm2 的 `kill_timeout` 保留 1300s 作为大余量兜底。
- **操作者路径也继承 `abort_wait`**：手动按第二次 Ctrl+C 之后同样武装它。放弃等待请求并不等于同意无限等待 barrier，而在此之前，唯一的出路是一次可能根本没人在场去按的第三次信号。
- **已武装的界不随热重载移动**：值在认领 lifecycle 时读一次。运维问「最多还要多久」，得到的答案不该在脚下变。

## 代价与边界（不粉饰）

- **两个界都是墙钟判据，都可能截断仍在合法工作的请求。** `graceful_wait` 到点时，一条还在正常产出的长请求会被终止——它的记录留住了，但它的**结果**没有。这正是 2026-08-07 之后大家想避免的那一类事；本裁决接受它，理由是「记录不丢」把损失从「无法诊断的静默失败」降级为「可解释的提前终止」。
- **`abort_wait` 到点是真的丢数据**：它按设计不 flush。它只在 barrier 本身卡住时才会触发，而那时的选择是「丢一部分」与「永远不退出」。
- **本 ADR 不改第二档信号的既有诚实边界**：`reapInFlight()` 打的 `CancellationCause` 仍写死 `stale-reaper`，客户端看到的取消 provenance 仍不是真成因（登记在 `docs/todo/deferred-backlog.md`）。因此 2026-08-10 ADR 里那句「在那条闭合前，不得声称第二档的终态『绝不被读成 timeout』」**继续有效**，本轮的自动路径同样适用。

## 未采纳的替代方案

- **只加 `graceful_wait`、不加 `abort_wait`**：barrier 卡住时进程仍会永远不退，`TimeoutStopSec` 只能靠 SIGKILL 收场，等于把无损 flush 换成必然丢数据。
- **让 `graceful_wait` 到点直接硬退**：那就是 2026-08-07，只是换了个变量名。
- **界只作用于 drain 循环**：会漏掉 `stopping` 阶段的两处无界 await，而那正是 2026-08-09 实测把客户端钉死七分钟的地方之一。

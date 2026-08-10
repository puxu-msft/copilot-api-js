# ADR: startup VACUUM 按锁竞争 gate，而非按行状态

- **状态**：Accepted
- **日期**：2026-08-10
- **裁决人**：用户（本会话裁决「history 分库：先解决争抢，后推进读写分离」）
- **相关**：修订 History V3 plan §6 / §4b 的「liveness gate 不采纳」裁决；[lifecycle.md](../lifecycle.md)「overlap 窗口的共享状态安全」隐患 ⑤；skill `history-sqlite-schema` DB-health 节；同源 ADR [three-tier-shutdown-signal-contract](2026-08-10-three-tier-shutdown-signal-contract.md)

## 背景

History V2 的开库路径有一道 liveness gate：按 `isProcessAlive(owner_pid)` 跳过维护动作，避免误伤另一个活进程正在写的行。迁到 V3 时这道 gate 被**明确地不采纳**，理由写在 `src/lib/history/sqlite/connection.ts` 的注释里：

> V3 的 `v3_operations` 只存终态（committed）行，没有 pending/executing/streaming 概念，所以不存在「另一个进程可能仍在写某个进行中的行」这种需要 VACUUM 避让的风险。

**这个论证本身是对的，但它避让错了对象。**

VACUUM 需要避让的不是**任何一行的状态**，而是**锁**：它持有独占写锁的时长等于重写整个文件的时长，远超 peer 的写所拥有的 5 秒 `busy_timeout`。行是不是终态，与这件事无关。

优雅重启正是这个风险的引爆点：**新进程在 boot 期开库，而此刻旧进程仍在全速服务**——交接信号要到 `notifyReady`（`packages/cli/src/start.ts:580`）才发出，比开库晚得多。两者恰好在这个 VACUUM 可能触发的时刻重叠。

同一文件里另一条注释也建立在同一个错误前提上，一并修正：

> We are still single-connection at startup (server not yet listening) so TRUNCATE takes its exclusive moment uncontended.

takeover overlap 下这句不成立。

## 定夺

**在启动 VACUUM 之前先探测锁竞争，判据取自 `PRAGMA wal_checkpoint(TRUNCATE)` 的 `busy` 列；`busy` 非零就跳过这次 VACUUM。**

TRUNCATE checkpoint 想要的正是 VACUUM 随后要长时间持有的那个独占瞬间，所以它的 `busy` 是「此刻抢得到那个瞬间吗」最便宜的答案——而且这个调用**函数原本就已经在做**（VACUUM 前的 WAL 收缩），改动只是开始读它的返回值。

### 这个判据实际测到的是什么（比标题窄，别记错）

实测（`bun:sqlite`，四格只变一个条件；探针见本 ADR 末尾复现步骤）：

| 场景 | `wal_checkpoint(TRUNCATE)` 返回 |
|---|---|
| 无 peer，WAL 有内容 | `{busy:0, log:0, checkpointed:0}` |
| **peer 连接已开，但没有事务**，WAL 有内容 | `{busy:0, …}` —— **放行** |
| peer 持着读事务，WAL 有内容 | `{busy:1, log:1, checkpointed:0}` |
| peer 事务已提交，WAL 有内容 | `{busy:0, …}` |

所以它测的是「**此刻有没有别人持着事务**」，**不是**「有没有别的连接开着」；而且还有第二个必要条件——**WAL 必须非空**，空 WAL 时 checkpoint 无事可做，恒返回 `busy:0`。

**因此本 gate 缩小危害窗口，但不消除它。** 一个已经打开库、此刻恰好空闲的前任进程会被放行，若它在 VACUUM 期间恢复写入，仍会撞上那把长时间的独占锁。要真正消除，得换成不依赖「采样瞬间」的判据（进程发现、或分片布局让新旧进程根本不写同一个文件——见 `docs/todo/deferred-backlog.md` 的读写分离条目）。选择这个判据的理由是**代价近乎为零且没有反向风险**：它复用已有调用、误判方向只会「少做一次 VACUUM」（下次启动再做），而不会误伤数据。

### 为什么不用 pidfile

pidfile 判据在**最需要它的场景失效**：`lifecycle.md` 明确规定 pidfile 机制是**裸手动路径专属**，systemd / pm2 路径故意不写 pidfile——而那两条路径的 blue-green 部署是**设计上保证有 overlap** 的。`busy` 探测则三条运行路径行为一致，且不需要 `history/sqlite` 反向依赖 `restart` 模块（那会撞包边界与环依赖 ratchet）。

### 探测必须用零 busy_timeout

探测前置 `PRAGMA busy_timeout = 0`、之后恢复。否则**探测自身**会在每一次有 overlap 的启动上阻塞满 5 秒——这不是推演，是覆盖测试**超时而非断言失败**暴露出来的。

## 现实性（实测，勿夸大）

活实例当前**远未达到触发阈值**，此缺陷在那里不可达：

| | 实测值（2026-08-10，132 MB 库） | 触发门槛 |
| --- | --- | --- |
| freelist 字节 | 2.26 MB | ≥ 64 MB |
| freelist 占比 | 1.7% | ≥ 25%（与前者是**与**关系） |

但它随库增长而变为可达：归档的 `history-v3-260809.db` 有 **13.9 GB**，那个量级下两个条件很容易同时命中，而代码自身在 `VACUUM_WARN_BYTES = 1 GB` 处就已经警告「will block briefly」。

## 验证

两条测试共用同一个膨胀过阈值的库，**唯一变量是有没有一个持着事务的 peer**，因而同时钉住两个方向：

- 既有 `maybeVacuumOnStartup fires on reopen`（无 peer）→ VACUUM 照常触发，freelist 归零。**未修改，仍绿**。
- 新增 `maybeVacuumOnStartup skips while another connection still holds the database`（peer 持读事务）→ 跳过，freelist 保持 > 0。

变异对照：把 gate 去掉后**只有新增那条**变红，且红的形态是超时 5 秒——直接演示了缺陷本身（VACUUM 撞 peer 锁后等满 `busy_timeout`）。

**这组测试钉住的是探针的输出，不是危害本身。** 它证明「持事务的 peer 在场时不 VACUUM」，**没有**证明「不 VACUUM 就不会有 SQLITE_BUSY」——上面已说明空闲 peer 会被放行。别把它读成后者。

### 复现上表的探针

```ts
// bun run <此文件>.ts —— 每格前先写入，制造新的 WAL 内容；
// 空 WAL 时 checkpoint 无事可做、恒返回 busy:0，会让四格看起来一样。
import { Database } from "bun:sqlite"
const db = new Database("/tmp/probe.db", { create: true })
db.exec("PRAGMA journal_mode = WAL;")
db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);")
const probe = () => {
  db.exec("PRAGMA busy_timeout = 0;")
  const r = db.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get()
  db.exec("PRAGMA busy_timeout = 5000;")
  return r
}
// 依次：无 peer / peer 已开无事务 / peer 持读事务 / peer 已提交，每格前 INSERT 一行再 probe()。
```

## 范围

本 ADR **只解决 overlap 期的锁争抢**。用户同期裁决的「主程序只 append 写、读/搜索/聚合全部外移 sidecar」是更大的方向，登记在 [todo/deferred-backlog.md](../todo/deferred-backlog.md)，不在本次范围内。

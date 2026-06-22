---
name: methodology-record-disappearance-forensics-and-silent-destructive-ops
description: 已落盘记录"消失"的系统排查(durability/restart/eviction/clear 逐一证伪);破坏性 bulk 操作(clear-all/delete)无日志=与持久化 bug 不可分辨,必须高声记录;live-churn DB 直读会得 torn snapshot,用运行进程的 API
metadata:
  type: feedback
---

一条**确认已落盘**的记录后来"消失",别急着归因。逐一用证据证伪每条删除/丢失路径,顺序:

1. **durability(掉电/VM 重启)**:`uptime -s` 看系统启动时间 vs 记录时间。`synchronous=NORMAL`(WAL)只在**掉电/OS 崩溃**丢未 fsync 的近期事务,**不**在进程重启丢(已 commit 的写在 OS page cache,SIGKILL 也存活)。系统 up 数天=排除。
2. **服务重启删的**:进程启动时间(`ps -o lstart`)vs 记录时间——重启**不删** SQLite 行(schema 全 `CREATE IF NOT EXISTS`、无 DROP;`reclaimOrphanedActiveRows` 只翻 active 行不删终态);若服务贯穿记录始终未重启,排除。
3. **reaper 淘汰**:日志有 `evicted N success/failure` 计数;失败桶要超上限(默认 200)才淘汰、且会打日志。日志全 `+ 0 failure`=排除。
4. **clear/delete(API)**:`clearHistory`(DELETE /api/entries)/`deleteSession`(DELETE /api/sessions/:id)是**唯二**能删终态行的路径。

**核心教训:破坏性 bulk 操作(清空全部/删 session)无日志 = 与持久化 bug 完全不可分辨,害我排查极久。** `clearHistory`/`clearAllEntries` 当时静默无痕,而它正是真凶(很可能 dev UI 在 HMR 下误触发 `DELETE /api/entries`)。**Why**:单条 `catch→warn` 是一类静默,"删全部"零日志是另一类——一次不可逆全量销毁必须高声 WARN(条目数+触发来源)。已落地:`clearHistory`/`deleteSession` 现 WARN 记录。呼应 [[methodology-persistence-swallow-plus-lossy-fallback-loses-data]]。

**附:live-churn DB 直读不可信(torn snapshot)。** 高吞吐下直接 `cp db + db-wal + db-shm`(三文件顺序拷、时刻不一致)再 bun:sqlite 读,只得一小段一致子集(我曾把一个在churn的库读成 6 行);`sqlite3 -readonly` 在活跃 WAL 上间歇返回空。**可信读法=用运行中进程自己的 REST API**(它用自己连接的一致 WAL 视图),而非旁路直读文件。延伸 [[empirical-probe-via-history-api]]、[[feedback-pass-null-clean-not-self-validating]](否定结果"查不到"不自证,可能只是读串)。

**How to apply**:记录消失→先按 1-4 逐条证伪(每条给证据),别先猜;读 live 库一律走运行进程 API;给任何"删全部/删一批"的破坏性路径加高声日志,否则下次它再触发又是一次盲查。

---
name: methodology-sqlite-bloat-check-freelist-first
description: "SQLite 库体积异常先查 freelist/page_count 比例,别先怀疑压缩;auto_vacuum=0 删行永不收缩文件;freelist 小但文件大→查 dbstat 找孤儿表(死表 live 数据 VACUUM 救不了,须先 DROP)"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 51d56536-5c7a-43aa-85d0-1a34c7c557e1
---

SQLite 库文件异常大时,**先查死空间占比,别先怀疑数据量或压缩**。实测案例:copilot-api 的 `history.db` 涨到 2.17GB,排查发现 **98.7% 是删行后未回收的 freelist 死空间,真活数据仅 28.8MB**。

诊断命令(只读连接,WAL 下可与运行进程并发):
```
sqlite3 "file:db?mode=ro" "PRAGMA page_count; PRAGMA freelist_count; PRAGMA page_size; PRAGMA auto_vacuum;"
```
`freelist_count × page_size` = 可回收死空间;`/ page_count` = 占比。

根因:**SQLite 删行不把空间还给 OS**(`auto_vacuum=0` 默认下),文件停在历史高水位。reaper/分桶淘汰把行数压住了也没用——一次 `VACUUM` 即 2GB→~30MB。

修复关键(已实证):
- `PRAGMA auto_vacuum=INCREMENTAL` **必须早于 `journal_mode=WAL` 设置**(在空库、建表前);反序会被锁死 mode 0,需全量 VACUUM 才能切。
- 改既有库的 auto_vacuum 模式**必须配一次全量 VACUUM** 才生效;之后 reaper 每 tick `PRAGMA incremental_vacuum` 持续还空间(仅 `auto_vacuum==2` 时有效,否则 no-op,须先查 pragma 守卫)。
- 启动期 VACUUM 全程 try/catch **绝不阻断启动**(VACUUM 需排他+等量临时磁盘,重启窗口另一连接持 WAL 锁会 SQLITE_BUSY);前置 `wal_checkpoint(TRUNCATE)` 降锁竞争。

## 第二条轴:freelist 小但文件仍大 → 孤儿表

上面是 freelist 死空间(VACUUM 能救)。**互补案例**:`history.db` 涨到 1GB,但 freelist 仅 294 页(1.2MB)——从 SQLite 视角"全是 live data"。根因不是 freelist,而是一张 **v1→v2 迁移留下的孤儿表 `entries`**(652 行 / 932MB):全代码库零引用,read/reaper/VACUUM 全只认 `entries_v2`,于是它永不被读/淘汰/回收。`maybeVacuumOnStartup` 的 `freelist/page_count ≥ 25%` 判据**永远抓不到它**(孤儿行是 live、不进 freelist)。

诊断**不能只看 freelist**,要 dbstat 看**逐表字节**:
```
sqlite3 "file:db?mode=ro" "SELECT name, SUM(pgsize)/1048576 AS MB FROM dbstat GROUP BY name ORDER BY SUM(pgsize) DESC;"
```
一眼看到 `entries`=932MB / `entries_v2`=16MB,孤儿表立现。再 `.schema <表>` + grep 全仓确认零引用。

修复**与 freelist 死空间不同**:VACUUM 救不了 live 死表,必须先 `DROP TABLE`(把 live 页转成 freelist),DROP 后 incremental_vacuum/VACUUM 才能还 OS。若死表的行还想留(本例保留 13 个 failed),先回迁进活表再 DROP——复用 canonical 写路径别手搓拆分:`deserializeEntry`(v1 单 blob 行→完整 entry)→ `insertCompletedEntry`(再拆 head/stage,同 id `ON CONFLICT DO UPDATE` 幂等)。落地为 `scripts/migrate-legacy-entries.ts`。全程线上库只读诊断、写操作设 `busy_timeout` 与运行 server 并发(它只写 entries_v2,撞锁由 persist-guard 当 transient 吸收)。

参见 [[reference-zstd-dict-ineffective-use-combined-frame]](同次存储瘦身)、[[methodology-persistence-swallow-plus-lossy-fallback-loses-data]](查不到的行先疑 swallow)。

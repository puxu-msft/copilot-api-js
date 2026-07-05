---
name: methodology-derived-column-backfill-targeted-and-nonblocking
description: "denormalized 派生列(preview_text)逻辑变更→须 backfill 旧行;但 backfill 必须靶向解压(只取需要的子集)+非阻塞后台(绝不进 openDatabase 同步路径),否则卡死启动"
metadata: 
  node_type: memory
  type: project
  originSessionId: 70757e80-4368-4a63-b800-08ccf0453262
---

denormalized/派生列（如 `entries_v2.preview_text` = `extractPreviewText(entry)`，写时算一次、读路径不重算）的**生成逻辑一变更，所有已存行就永久陈旧**——光重启不够（读的是存储的旧值）。须一次性 backfill 重算，按 `PRAGMA user_version` 守卫只跑一次（逻辑再变 bump 常量重跑）。但 backfill 本身有两个必踩的坑：

**坑① 成本爆炸（靠"重建全对象"而非靶向取子集）**：首版用 `assembleFullEntry(row, allStages)` 重建整条 entry 只为读 `inboundRequest.messages`——它解压**整条请求生命周期**（inbound+effective+outbound+response+**sse_events** × 每 attempt）。在 4.2G 库（单 session 1.84 亿 tokens、sse_events 流式帧是最大的 blob）上解压数 GB、653 条耗 **3m53s**。修法=**只解压需要的那个 stage**（这里 `inbound_request`，但注意 finalized entry 把它打包进 B3 `request_group` dedup 容器帧、不是独立 stage 行，故 `stage IN ('inbound_request','request_group')` + 解容器成员；legacy 无 stage 行回退读 head blob），并 `SELECT id, preview_text` 不 `SELECT *`（不拉 head blob）。

**坑② 同步跑在 `openDatabase` 里 = 卡死整个启动**（看起来像死机，最后一条日志停在 "Data directory" 后几分钟）。修法=**非阻塞后台**：移出 openDatabase，由 `start.ts` 监听之后 fire-and-forget（`startPreviewBackfill()`），核心函数 async、50/批 `await sleep(0)`（`node:timers/promises`）让出 event loop、批间**不持事务**（否则锁住 writer 整个 backfill 期）。**双重 never-throw**：后台 detached promise 的 reject 会冒泡到 `main.ts` 的 unhandledRejection→`exit(1)` 崩整服务器（见 skill `debugging-server-crashes`），故 `void fn().catch(warn)` + 内部 try/catch 都要有。

**裁决哪步慢用日志时间戳实测、别假设**（[[empirical-probe-via-history-api]] 同源）：用户报"卡在 Data directory 后"，我没有因为他提了 backfill 就认定——查日志 `19:20:08 Data directory` → `19:24:01 preview backfill: recomputed 639...` 锁定是 backfill 而非启动 VACUUM（且 DB 仍 4.2G、freelist 仅 2MB → VACUUM 根本没触发，[[methodology-sqlite-bloat-check-freelist-first]]）。

**靶向解压须等价性 oracle 钉死**（[[feedback-self-consistent-needs-independent-oracle]]）：inbound-only 提取若漏某种 entry 形态会把好预览覆盖成空，比陈旧更糟。测试断言 `storedPreview(id) === extractPreviewText(getEntryById(id)!)`（后者走 `assembleFullEntry` 全路径）= 新靶向路径 ≡ 旧全路径，而非只断言一个硬编码字面量。配套：在派生函数（`extractPreviewText`）上加注释警告"backfill 是 inbound-only、若改读 inbound 外字段须同步改 backfill"——编译期没有这层耦合的强制。

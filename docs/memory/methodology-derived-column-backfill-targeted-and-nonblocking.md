---
name: methodology-derived-column-backfill-targeted-and-nonblocking
description: 派生列 backfill 须靶向解压+非阻塞后台已归入 skill history-backfill；见那里
metadata:
  type: project
---

**已归入 skill `history-backfill`（派生列 backfill）。** 钩子：denormalized 派生列（preview_text）逻辑变更→须 backfill 旧行；但必须**靶向解压**（只取需要的 stage、别 `SELECT *`：4.2G 库卡 3m53s）+ **非阻塞后台**（绝不进 `openDatabase` 同步路径，否则卡死启动）；靶向解压须等价性 oracle。相关 [[feedback-pass-null-clean-not-self-validating]]（否定性结果不自证）。

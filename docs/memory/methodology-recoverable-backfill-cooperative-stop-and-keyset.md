---
name: methodology-recoverable-backfill-cooperative-stop-and-keyset
description: 可恢复后台 backfill 的生命周期方法论已归入 skill history-backfill；见那里
metadata:
  type: project
---

**已归入 skill `history-backfill`（可恢复骨架）。** 钩子：协作式 stop 须匹配关资源的 shutdown phase、(started_at,id) compound keyset 跨 ties 无损续跑、meta-flag 守卫非 user_version、内容寻址须 dedup-ratio tripwire、非阻塞分批 + never-throw。相关 [[methodology-sync-to-async-persistence-refactor-invariants]]、[[methodology-derived-column-backfill-targeted-and-nonblocking]]、[[feedback-pass-null-clean-not-self-validating]]。

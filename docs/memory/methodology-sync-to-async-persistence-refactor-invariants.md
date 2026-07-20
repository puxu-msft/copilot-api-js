---
name: methodology-sync-to-async-persistence-refactor-invariants
description: 把同步持久化路径改异步的不变量清单已归入 skill persistence-async-invariants §1；见那里
metadata:
  type: feedback
---

**已归入 skill `persistence-async-invariants` §1（同步持久化路径改异步的不变量清单）。** 钩子：drain-before-close 结构性前置（别假设 drain 机制已存在）/ 自有 pending Set 不靠 bus / fixture teardown 先 drain / re-entrancy Set 守卫 / fire-and-forget never-throw / 全调用方 await（typecheck 过≠正确、内联调用易漏）。活档 `docs/spec/history-finalize-async-offload.md`。

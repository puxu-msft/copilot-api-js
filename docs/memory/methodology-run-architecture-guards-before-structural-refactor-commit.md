---
name: methodology-run-architecture-guards-before-structural-refactor-commit
description: 结构性重构提交前须跑架构守卫/全 backend 而非只跑直接相关测试——grep 源码形状的守卫会被合法重构打红
metadata: 
  node_type: memory
  type: project
  originSessionId: c920d902-6204-44cc-a3c9-8980aa0b5232
  modified: 2026-07-23T03:27:56.643Z
---

结构性重构（改函数骨架、重命名内部机制、换数据结构）提交前，**除直接相关测试外，必须跑架构守卫测试 + 全 `test:backend`**，别只跑「明显相关」的那几个文件。

实例（h2 池 capacity-routing 重构）：C2 把 `retire` 里的 `sessions.delete(origin)` 改成 `removeSessionEntry(entry)`（因池从 `Map<origin,entry>` 升 `Map<origin,entry[]>`）。我只跑了 `tests/transport/`（全绿）就把 C2 提交到**共享 master**，漏了 `tests/architecture/generation-engine-boundaries.unit.test.ts`——它 **grep http2-client.ts 源码**断言 `const retire = ... sessions.delete(origin) ... retiringSessions.add(entry)` 这个精确形状。合法重构改了机制 → 守卫打红 → 我把 master 留成了红态（修复在 feat 分支，合并后才转绿）。同批还有 `config-hot-reload.it.test.ts` 的「每个 ConfigSchema 叶子键须被测试或豁免」完备性守卫，新增 config 键漏登记会红。

**Why:** 本项目有一层「grep 源码结构 / 枚举 schema 叶子 / 检查导入边界」的 L1 架构守卫（`tests/architecture/*`、config 完备性），它们**不在 transport/直接相关目录下**，只有全 backend 才覆盖。结构重构恰是最容易触发它们的改动类型，而「只跑直接相关测试」正好漏掉它们。

**How to apply:** 任何改了代码形状/骨架/数据结构/新增 config 键的 commit，提交**前**跑 `bun run test:backend`（含 architecture + config 完备性守卫），别只跑改动文件所在目录。守卫打红时先辨方向——多数是守卫锁的旧形状需随重构更新（更新断言 + 注释说明不变量仍成立），而非重构错了。关联 CLAUDE.md `dont-ignore-existing-errors`、[[feedback-verify-named-target-resolves-before-large-work]]。

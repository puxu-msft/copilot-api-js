---
slug: poc-runner
status: poc-complete-awaiting-design-decision
base: 44e557c159fe80f90589f6bb581ac985795c4dd2
branch: agent-a0b5eee4b161ab9ab
worktree: /home/xp/src/copilot-api-js/.worktree/agent-a0b5eee4b161ab9ab
plan: /home/xp/src/copilot-api-js/.worktree/agent-a0ace38c28cd88da1/.superpowers/sdd/task-9-summary-integrity-architecture.md
agent_id: agent-a0b5eee4b161ab9ab
session_id: unknown
continuity: must-remain-continuous
continuity_reason: 该 PoC 的候选机制、反例与控制实验互相依赖，换实例会丢失未被 Git 表达的淘汰理由。
---

# History summary write authority PoC 进度

## 阶段清单

- A（已完成）：列出 Bun 1.3.14 与当前 Node SQLite backend 的公开 API。实测产物在 `exp/history-summary-write-authority/runtime-api.json`；Bun 无公开 function/aggregate/authorizer，Node v24.16.0 三者均存在且已实跑；统一 driver 未暴露这些能力。
- B1（已完成）：本机 C extension + Bun `loadExtension`/`bun:ffi` host toggle，以及 Node closure UDF 均使 persistent trigger 同步读取 connection-local controlled maintenance mode；普通 SQL 不能切 mode，第二 connection 独立，host scope 写入成功，清零后恢复拒绝。正式采用需新增 native C artifact 与统一 driver scope API。
- B2（已完成+Important 整改）：Bun/Node 同语义 helper 采用所有 nested scope fail closed；“sync-only”只约束 callback 返回值，不阻止 Promise executor/then getter 在检查前同步执行。事务外两类副作用实测已持久化；transaction-wrapped 形态在 TypeError 后 rollback，副作用不存在，故正式原子性边界必须包含 SQLite transaction。所有异常后 mode 清零，普通 SQL/第二 connection 仍拒绝；cleanup 与 side-effect rollback mutation 双 runtime 均变红。Node trigger reentrant 实跑；Bun not applicable。
- B3 correctness（已完成）：纯 SQLite normalized refs + integrity epochs schema 已生成 512 summaries × refs 0/4/32 × 256 KiB manifest。v1/v2/valid-v3 为 ready，future/digest mismatch/write-after-attestation 为 not-ready。但普通 SQL 可同步重写 canonical 与 integrity/status/marker，使错误状态重新 ready，确认无独立 writer authority 时存在 criterion gap／物理 blocker。
- B3 performance（已完成）：get/list/session/stats 在 refs 0/4/32、payload 64 B/256 KiB 下完成 EXPLAIN 与 15 轮随机 paired wall-time。Integrity plan 通过 covering indexes 避开 manifest payload，但四类查询均有 per-summary correlated refs anti-join；成本随 refs 明显增长。结果仅为本机 in-memory 观测，无阈值、无零回归结论。
- PoC 实验阶段（已完成）：A/B1/B2/B3 资产、结论边界与复跑命令已落 `exp/history-summary-write-authority/`；最终独立 review 裁决删除 tracked Linux x86-64 `.so`，保留 C 源码、build recipe、probe 与本机 artifact SHA256。
- 后续（不属于本 PoC 产品落地）：由主会话／用户在 A-B 候选间裁决并重写正式设计；本进度文件不替代该设计裁决，也不表示产品代码已实施。

## 收口状态

- 步骤 A、B1、B2、B3 correctness 与 B3 performance 均已完成并经最终独立 review；PoC 实验阶段结束，待主会话／用户做 A-B 方案裁决与正式设计，不是产品落地。
- 未安装依赖；所有 probe 仅使用 `:memory:` 假数据，未触碰 4141，未修改产品代码或全局配置。
- B1 使用本机既有 `cc` 与 Miniconda `sqlite3ext.h` 构建实验 `.so`；最终不追踪二进制，复跑时先按 README 配方重建。Bun 可经 `loadExtension` + `bun:ffi` 无 SQL setter toggle，Node 可经 closure UDF。正式方案的关键变化是 native artifact 交付与统一 driver transaction-bound scope API，不是 SQLite trigger 本身。

## 已作废的路子

- Bun `Database.handle` 当作 `sqlite3*` 传给系统 SQLite：该值是 Bun 内部 handle index，不是原生指针。
- Bun `fileControl()` 切 extension 私有 connection state：公开 file-control contract 没有 extension-defined host toggle 接缝；B1 改用 extension 导出符号 + `bun:ffi`。
- Bun trigger reentrant host callback 的合成调用：extension 没有 native→JS callback channel，直接调用 helper 不能代表 trigger 路径，故明确标为 not applicable。
- 纯 SQLite epochs/status/marker 作为普通 SQL writer 无法重新认证的 authority：反例已实测普通 SQL 可把 subject 与 derived validation state 一起改成自洽 ready；后续只把 B3 当检测未协调变化与性能候选，不再声称它独立闭合 authority。

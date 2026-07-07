# P5 kick-off — doc-sync + golden 回归（收尾）

**前置**：P4 完成。读 [../README.md](../README.md) + [../plan.md](../plan.md)「P5」+ skill `session-closeout`。

**为什么**：活文档与代码同步是「完成」的一部分（sync-live-docs）。

**目标**：更新 `docs/DESIGN.md`（类型架构节 → client/upstream 双腿）、`docs/history.md`（leg 描述）、`.claude/skills/history-sqlite-schema/`（stage 名/字段）；RFC 头部标「已实施」。

**验收**（skill `session-closeout` 步②③）：跨文档 grep 无 `inbound/outbound/wire/effective` leg 旧述残留；全 `bun test` + `bun run typecheck` + `build:ui` + P0 三 golden 终跑绿。

**提交**：`docs(history): sync live docs to client/upstream data model`。

**收尾**：更新记忆库（MEMORY.md 加一条指向本重构的 stub）；本计划头部标实施状态。

**红线**：../README.md。

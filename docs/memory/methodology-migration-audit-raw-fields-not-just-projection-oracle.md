---
name: methodology-migration-audit-raw-fields-not-just-projection-oracle
description: 覆写原始 blob 的迁移前须审计真实库原始字段覆盖；projection-等价 oracle 对「已死字段」是盲的、会放过静默丢失
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 659a289a-b673-4403-aef9-7771079738a7
---

当一个读适配器 / backfill **覆写原始 blob**（为达单轨），它的等价 oracle（消费者可见 projection 等价）对「重构后已对所有 consumer 不可见的字段」是**盲的**——这类字段过 oracle 却被静默 drop。启用这种覆写迁移前，必须**审计真实生产库的原始 on-disk 字段集** vs 适配器映射集（只读探针：解压真实 blob、逐 stage 枚举实际 key、diff 适配器所映射字段），而**不能只信 oracle**。

**本会话实例**：history 双腿重构的读适配器 `adaptUpstreamResponse` 丢弃 legacy `outbound_response.error`（真字段、不可派生、真实库确含）。等价 oracle **通过**（该 error 在 P4c-3 后 detail 视图已不可见，属「已死字段」）；只有对**真实 history.db 的原始字段审计**（枚举 blob key）才抓到它——否则 P6 backfill 一跑就把它变成 at-rest 永久丢失。修复=路由到新归属 `attempts[].error`（fallback-only 守卫）。用户「先实测审计再 merge」的谨慎正是救了这份数据。

**Why:** projection-等价 ≠ archival-完整（richest-data-flow ADR「后端存完整」）。equivalence oracle 只证「在意的 consumer 无可观测变化」，覆盖不到「无 consumer 但仍在盘上的字段」。

**How to apply:** 合并任何**覆写 blob** 的 backfill 前，跑只读探针枚举真实库每种 stage/blob 的实际字段 vs 适配器映射；任何被适配器 drop 的字段，除非**证明可派生**（如 messageCount=messages.length），一律当作数据丢失、补路由或保留原始。列存派生列（迁移不动列）不受此影响，只影响 blob 覆写。

**Related:** [[history-backfill]] skill 的「等价性 oracle」（本条是其盲区补充：oracle + 原始字段审计双证）、richest-data-flow ADR、[[project-history-client-upstream-legs-landed]]。

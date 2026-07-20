---
name: project-history-client-upstream-legs-landed
description: history 数据模型已重构为 client/upstream 双腿 + 逐 attempt 上游轨；旧库行经读适配器兼容；分支 merge-ready 待合入
metadata: 
  node_type: memory
  type: project
  originSessionId: 659a289a-b673-4403-aef9-7771079738a7
---

history 记录数据模型已从 `inbound/outbound/wire/effective` 命名坐标系重构为 **client/upstream 双腿 + 逐 attempt 上游轨**（四轮 RFC 对抗 review + subagent-driven 逐 phase 两审，最终全分支 review 判 MERGE-READY；**已 merge 入 master `5db1aff6`**——含核心 leg 重构 + P6 legacy-stage backfill + 审计 fix；ff 发布，peer 并发 crash-safety 工作无损共存）。

新结构：`clientRequest`/`clientResponse`（proxy↔client，per-entry）+ `attempts[].{effectiveSource,upstreamRequest,upstreamResponse}`（proxy↔upstream，per-attempt）+ `model{requested,resolved,multiplier}` + `_index{derived,aux}` + `preprocessing`。两条正交轴：**attempt 成败**（`upstreamResponse.success`）vs **entry 客户端结局**（`state`），刻意分离。

关键实现事实：
- **live `RequestContext` 未改名**（`Attempt.{effectiveRequest,wireRequest,response}`、`_httpHeaders` 捕获袋保留旧名）——仅**持久化模型 `HistoryEntry`** 采用新腿。源码里旧名残留几乎都在 live-context 层，非遗漏。
- **历史 DB 行（旧 stage）经 `adaptLegacyLegsInPlace`（serialize.ts）读时适配为新腿**——历史行渲染仍活。**P6 backfill 快跟**（迁旧行→新 stage 后删适配器达单轨）是已知独立 fast-follow，见 [[project-history-legs-p6-backfill-pending]]。
- **Group-B 标量**（requestBytes/responseBytes/multiplier/warningMessages）暂留列支撑/扁平，`_index.aux`/`model.multiplier` 迁移入 `docs/todo/deferred-backlog.md`。
- `effectiveSource` = env.body 本尊（本轮 pipeline 工作格式，Gemini 路径已是 CC）；`upstreamRequest` 含 messages 结构化投影（rewrites-req 搜索 facet 依赖）。

权威归属：`docs/DESIGN.md`「类型架构·History 数据模型」+ `docs/history.md` + skill `history-sqlite-schema` + RFC `docs/rfc/2026-07-07-history-data-model-restructure.md`（标已实施）+ plan `docs/plan/history-data-model/`。

# 2026-04-14 文档准确性审查快照（归档）

> **归档于 2026-06-28。** 本目录是 2026-04-14 一次性的"文档对照源码"审查批次（每份 `*_实施状况.md` 逐条核验对应 `docs/*.md` 的声明是否与当时代码一致）。

## 为何归档

这些是 **point-in-time 快照**：审查结论反映 2026-04-14 的代码状态，此后代码已演进数月，多数 ✅ 结论已失效。典型：
- `src/lib/history/memory-pressure.ts`（`MemoryPressureManager`）在 **2026-06-04（commit 7561a7b）被删除**——`shutdown_实施状况.md` / `history_实施状况.md` 里标 ✅ 的 `stopMemoryPressureMonitor()` / `MemoryPressureManager` 现已不存在。
- `src/lib/context/consumers.ts` 已删、迁 observability bus + sinks；shutdown 的 WS-客户端关闭从 Phase 1 移到 Phase 4。

故作历史记录归档，**不应再当作当前状态依据**。

## 归档前已 harvest 的仍有效发现（2026-06-28 重新核验）

- **shutdown**：审查指出 `docs/shutdown.md` 状态机漏 `executing` —— 重新核验确仍有效（`RequestLifecycleState` 现为 7 态 `pending|executing|streaming|completed|failed|aborted|interrupted`），**已修进活文档 `docs/shutdown.md`**。
- **history**（2026-06-28 已修进活 `docs/history.md`）：审查的 REST/UI 发现重新核验**仍陈旧且漂移更远**——`GET /history/api/sessions/:id` 与 `/:id/entries` 路由现**均不存在**（route.ts 仅 `GET /api/sessions` 聚合 + `DELETE /api/sessions/:id`；session 的 entries 经 `GET /api/entries?sessionId=` 取）、`/history/v1` UI 不存在（仅 Vue `/ui`）。**已修**：删两条不存在的 session-detail REST 行 + 补 `?sessionId=`/`?search=` 取法、Web UI 表去 v1；"DELETE /api/entries 未文档化"亦已解决。WS topics/events 核验仍准确、未动。

## 内含

| 文件 | 审查对象 | 2026-04-14 总评 |
|---|---|---|
| `shutdown_实施状况.md` | docs/shutdown.md | 准确，漏 `executing` 状态（已 harvest） |
| `history_实施状况.md` | docs/history.md | REST 表 2 错 + Web UI v1 不存在（已 harvest 修复） |
| `260324-fixes_实施状况.md` | docs/260324-fixes.md | 2/8 已修，6/8 仍 todo |
| `model-resolution_实施状况.md` | docs/model-resolution.md | 准确，步骤编号细微差异 |
| `SECURITY_RESEARCH_MODE_实施状况.md` | docs/SECURITY_RESEARCH_MODE.md | ❌ 文档描述的功能代码中不存在 |

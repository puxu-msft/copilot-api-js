# Kickoff prompts — Requests 列表增强

每个 phase 一段，复制到新会话开头。执行子技能：**subagent-driven-development**（推荐）或 **executing-plans**。所有 phase 隐含遵守 [../README.md](../README.md) 的 Global Constraints + 红线。

---

## Phase 0 — 后端 scoped delete

```
实施 ui-v4/docs/plans/requests-list-enhancement/phase-0-backend-scoped-delete.md。
先读该 plan + README（Global Constraints + 红线）+ spec §9。这是后端一处小改：
新增 deleteEntries(filters) 照 src/lib/history/sqlite/write.ts 的 deleteSession
模式（DELETE FROM entries_v2 WHERE + FK CASCADE + GC_ORPHAN_MSG_BLOB_SQL），
绝不用 clearAllEntries 的无 WHERE 全表删（红线 H1）；带 status NOT IN
('pending','executing','streaming') 不删 in-flight head。逐 task TDD，bun test
+ typecheck 绿，显式 pathspec 细粒度提交。仓库有并发会话——绝不 git add -A。
```

## Phase 1 — 筛选基座

```
实施 ui-v4/docs/plans/requests-list-enhancement/phase-1-filter-foundation.md。
先读该 plan + README 红线 + spec §3/§4。核心：request-filters.ts 的 matchesGating
同构后端 summaryMatchesFilters（src/lib/history/queries.ts）且【绝不含 search 维】
（红线 C1——search 对 in-flight 是全文、对持久是 preview_text LIKE，preview 子串
门控会与后端分歧）；useHistoryInfinite 的 WS 门控判定顺序互斥（先「id 已在列表内
→原地更新→return」，再「新终态→incoming」，红线 H4）。逐 task TDD（bun test 纯逻辑
+ vitest hook），门禁绿，显式 pathspec 提交。
```

## Phase 2 — 筛选 UI

```
实施 ui-v4/docs/plans/requests-list-enhancement/phase-2-filter-ui.md（依赖 Phase 1）。
先读该 plan + README。要点：复用 shared FilterSelect（Radix Select）；state 下拉
【只列终态】completed/failed/aborted/interrupted（红线 3——列表 terminalOnly，非终态
会被全滤）；引入 react-day-picker 做时间范围，日界 from=00:00:00.000 / to=23:59:59.999。
逐 task TDD（vitest，fake timers 测防抖），门禁绿，显式 pathspec 提交。
```

## Phase 3 — 列表引擎（PoC gate 前置）

```
实施 ui-v4/docs/plans/requests-list-enhancement/phase-3-poc-and-list-engine.md（依赖 Phase 2）。
先读该 plan + README + ADR。【必须先做 Task 3.0 PoC gate】：exp/requests-virtuoso-poc/
实测 TableVirtuoso + @tanstack/react-table + jsdom（ResizeObserver + offsetHeight stub）
三者跑通并留 stub 方案文档，PoC 不绿则停、回 ADR 复议，勿硬推重写。之后 request-columns.ts
（列模型 + 列可见性 + COLUMN_WIDTHS 单一真值源）+ TableVirtuoso 重写 HistoryList +
scrollToIndex 定位（at×筛选归属用 matchesGating，无 search 维）。每 UI task 额外跑
bun run --filter copilot-api-ui-v4 build（验 ~backend 纯 + bundle 前后对照入提交信息）。
```

## Phase 4 — 态与交互

```
实施 ui-v4/docs/plans/requests-list-enhancement/phase-4-states-interactions.md（依赖 Phase 3 + Phase 0）。
先读该 plan + README。error/empty 三态 + 键盘导航（↑/↓/Enter/Esc + isTyping 守卫）+
筛选感知清空历史（shared/Modal 确认，文案带 total N，api.delete 传 toQueryString(filters)）+
paused 行内更新端到端验证（验 Phase 1 门控顺序）。收尾 session-closeout：全量门禁
（typecheck+test+build+后端 bun test）+ 文档同步（DESIGN 活架构现状 + TODO Activity 标对等）
+ subagent audit（裁判轴：长远正确+完整，非 ROI/YAGNI）+ 记忆维护 + 细粒度提交。
```

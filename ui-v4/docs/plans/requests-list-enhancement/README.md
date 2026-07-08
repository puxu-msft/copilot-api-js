# Requests 列表页全面增强 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐 task 执行。步骤用 `- [ ]` 复选框跟踪。

**Goal:** 把 ui-v4 Requests 列表页从「Live 泳道 + tail/缓冲 + 富行 + `?at=` 定位」增强到功能对等且超越老 `ui/` Activity：七维 server-side 筛选 + URL-as-SSOT 深链 + 错误/空态 + paused 行内更新 + 键盘导航 + 筛选感知清空历史。

**Architecture:** URL query 是筛选真值源（`useRequestFilters` 解析/写回，保留正交的 `?at=`）→ 进 `useHistoryInfinite` 的 queryKey 驱动 server-side refetch → TanStack Table 列模型（列可见性）→ react-virtuoso `TableVirtuoso` 虚拟渲染（`endReached` 加载旧页、`scrollToIndex` 定位）。WS 门控同构后端 `summaryMatchesFilters`（不含 search 维）。清空历史需一处后端 scoped delete（照 `deleteSession` 的 CASCADE+orphan-GC 模式）。

**Tech Stack:** React 19 + TypeScript + TanStack Query + zustand + Radix UI（已用）+ **新增 react-virtuoso / react-day-picker** + **@tanstack/react-table**（已装未用）。后端 Hono + bun:sqlite。

**权威依据**：spec [../../spec/2026-07-06-ui-v4-requests-list-enhancement.md](../../spec/2026-07-06-ui-v4-requests-list-enhancement.md) + ADR [../../decisions/2026-07-06-requests-list-libraries.md](../../decisions/2026-07-06-requests-list-libraries.md)。每个 task 隐含遵守下方 Global Constraints。

## Global Constraints（每个 task 隐含包含）

- **语言/风格**：面向开发者文字输出中文、技术标识符英文；无行末分号（`printWidth` 由 prettier 定）；Terminal Amber（amber / `rounded:0` / mono / 高密度），CSS 变量见 [src/styles/theme.css](../../src/styles/theme.css)、Radix 样式见 `docs/radix-styling.md`。
- **no-auto-server**：不跑 `dev`/`start` 或任何起服务器的命令；可跑 `typecheck` / `lint` / `test` / `build`。
- **测试命令**（在 `ui-v4/` 下）：bun 纯逻辑 = 文件名 `*.bun.test.ts`，跑 `bun test .bun.test`；vitest 组件 = `tests/*.vitest.test.tsx`，跑 `bunx vitest run <file>`；类型 `bun run typecheck`。后端 bun 测试（`*.test.ts` under `src/`）在**仓库根**跑 `bun test <path>`。
- **门禁全绿**（每 task 收尾）：`bun run typecheck` + `bunx eslint <改动文件>`（单文件核验须无缓存，见 [../../../docs/memory/tooling-eslint-cache-false-pass.md](../../../docs/memory/tooling-eslint-cache-false-pass.md)）+ 相关测试。**列表引擎阶段额外** `bun run --filter copilot-api-ui-v4 build`（rollup 验 `~backend/*` 纯 + **bundle 前后对照写入提交信息**）——`~backend/*` 模块只能 type-only import 后端，不得 import `~/lib/state` 等运行时（见 [../../../docs/memory/feedback-verify-ui-with-build-not-just-typecheck.md](../../../docs/memory/feedback-verify-ui-with-build-not-just-typecheck.md)）。
- **git**：细粒度 conventional commits，**一律显式 pathspec**（`git add -- <精确路径>`、`git commit -F <msg> -- <精确路径>`），不加模型署名。仓库有并发 agent 会话 + 文档重组在跑——绝不 `git add -A`/`git add .`。
- **search 维铁律（C1）**：前端 `matchesGating` 同构后端 `summaryMatchesFilters`（[src/lib/history/queries.ts](../../../src/lib/history/queries.ts)），**绝不含 search 维**（search 对 in-flight 是全文、对持久是 preview_text LIKE，preview 子串门控会与后端分歧）。search 过滤只发生在 refetch 的 SQL 层。
- **scoped delete 铁律（H1）**：后端 `deleteEntries(filters)` **严照 `deleteSession`（[src/lib/history/sqlite/write.ts](../../../src/lib/history/sqlite/write.ts):205）模式**——`DELETE FROM entries_v2 WHERE <filter>` 靠 FK CASCADE 清 req_msg/req_aux/entry_stages + 跑一次 `GC_ORPHAN_MSG_BLOB_SQL`；**绝不**用 `clearAllEntries` 的无 WHERE 全表 `DELETE FROM req_aux`（会误删他人 index 行 → 灾难性数据丢失）。

## 阶段 DAG

```
Phase 0 ─ 后端 scoped delete（独立、可先行）────────────────┐
                                                             ▼
Phase 1 ─ 筛选基座（纯逻辑 + hook + queryKey 接线）──▶ Phase 2 ─ 筛选 UI ──▶ Phase 3 ─ 列表引擎（PoC gate 前置）──▶ Phase 4 ─ 态与交互
```

- **Phase 0**（后端）与 **Phase 1**（前端基座）无依赖，可并行/任意序。
- Phase 2 依赖 Phase 1（消费 `useRequestFilters` + `matchesGating`）。
- Phase 3 依赖 Phase 2（filter bar 里挂列菜单）+ **前置 PoC gate**（三库组合实测）。
- Phase 4 依赖 Phase 3（虚拟列表就位后加态/键盘）+ Phase 0（清空历史消费 scoped delete）。

## 红线（绝不跨越）

1. WS 门控/`?at=` 归属判定**不含 search 维**（Global Constraint C1）。
2. scoped delete **只用 `deleteSession` 模式**（Global Constraint H1）。
3. `terminalOnly=true` 与非终态 state 冲突：state FilterSelect **只列终态**（`completed`/`failed`/`aborted`/`interrupted`）。
4. 门控判定**顺序互斥**：先「id 已在列表内→原地更新→return」，再「新终态→incoming」。
5. 不删 in-flight persisted head：`deleteEntries` SQL 带 `status NOT IN ('pending','executing','streaming')`。
6. 每次 Edit 后不留半坏中间态；跨文件独立 Edit 消息内并行。

## 阶段文件

- [phase-0-backend-scoped-delete.md](phase-0-backend-scoped-delete.md) — `deleteEntries(filters)` + `handleDeleteEntries` 参数化 + `api.delete` 返回计数
- [phase-1-filter-foundation.md](phase-1-filter-foundation.md) — `request-filters.ts` + `useRequestFilters` + `FilterSelect` 抽取 + `useHistoryInfinite` 接 filters + WS 门控
- [phase-2-filter-ui.md](phase-2-filter-ui.md) — `RequestsFilterBar`（Select/防抖/day-picker/列菜单）+ `RequestFilterChips` + 挂进 Page
- [phase-3-poc-and-list-engine.md](phase-3-poc-and-list-engine.md) — PoC gate + `request-columns.ts` + TanStack Table + `TableVirtuoso` 重写 + `scrollToIndex` 定位
- [phase-4-states-interactions.md](phase-4-states-interactions.md) — error/empty 三态 + paused 行内更新 + 键盘导航 + 清空历史确认

kickoff prompts 在 [kickoffs/](kickoffs/)。

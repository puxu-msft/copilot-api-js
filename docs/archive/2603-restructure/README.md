# 代码重构规划

## 目标

解决代码组织中的**命名不合理、职责不清、内容混乱**问题。不以行数为驱动。

## 完成状态

| Phase | 文档 | 优先级 | 状态 |
|-------|------|--------|------|
| 1 | [02-route-organization.md](02-route-organization.md) | P0 | ✓ 已完成 |
| 2 | [01-oversized-files.md](01-oversized-files.md) | P1 | ✓ 已完成 |
| 2 | [03-module-boundaries.md](03-module-boundaries.md) | P1 | ✓ 已完成 |
| 2 | [05-state-management.md](05-state-management.md) | P1 | ✓ 已完成 |
| 3 | [04-test-alignment.md](04-test-alignment.md) | P1 | ✓ 已完成 |
| 4 | [06-frontend-cleanup.md](06-frontend-cleanup.md) | P2 | ✓ 已完成 |
| 4 | [07-cross-cutting.md](07-cross-cutting.md) | P2 | ✓ 已完成 |

## 已完成的核心改动

**路由（02）**：`/ui` 成为规范入口；API/UI 拆分；`registerHttpRoutes`/`registerWsRoutes` 拆分；`usage/route.ts` 删除；`/history` 根路径 404

**职责拆分（01）**：6 个文件按职责域拆分——history/store、error、anthropic/sanitize、anthropic/auto-truncate、context/request、openai/auto-truncate

**模块边界（03）**：ws/、auto-truncate/、system-prompt/ 重组为正确的 barrel + 实现结构

**全局状态（05）**：State 接口 readonly + 分组 setter + 测试 snapshot/restore

**测试（04）**：命名对齐 + Playwright runner 隔离 + 时序敏感测试 waitUntil 改造

**前端清理（06）**：legacy 页面已标记维护态；`VDashboardPage` / `VModelsPage` / `useHistoryStore` / `DetailPanel` 已拆分为更清晰的页面容器与子组件/组合式模块

**跨领域（07）**：Vite proxy 已支持环境变量；`sanitize-system-reminder` shim 已删除，消费者全部改为直接使用 `~/lib/system-prompt`

## 剩余工作

无。01-07 全部完成，260328-4-findings.md 中的 9 个质量问题也已全部解决。

## 历史审查记录

| 文档 | 内容 |
|------|------|
| [260328-1-findings.md](260328-1-findings.md) | Codex 第一轮审查（初版文档方向性问题） |
| [260328-2-findings.md](260328-2-findings.md) | Codex 第二轮审查（措辞收敛、数字校正） |
| [260328-3-findings.md](260328-3-findings.md) | Codex 第三轮审查（事实与判断分离） |
| [260328-4-findings.md](260328-4-findings.md) | 代码拆分质量审查（H1-M4-m3 共 9 项，已全部解决） |
| [04-v2-flaky-timing-review-1.md](04-v2-flaky-timing-review-1.md) | 时序测试方案审查第 1 轮 |
| [04-v2-flaky-timing-review-2.md](04-v2-flaky-timing-review-2.md) | 时序测试方案审查第 2 轮 |

## 设计文档索引

| 文档 | 用途 |
|------|------|
| [02-v2-ui-entry.md](02-v2-ui-entry.md) | `/ui` 入口统一方案 |
| [02-v3-ws-registration.md](02-v3-ws-registration.md) | WS 注册拆分方案 |
| [04-v2-flaky-timing.md](04-v2-flaky-timing.md) | 时序敏感测试 waitUntil 改造方案 |

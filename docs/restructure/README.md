# 代码重构规划

## 目标

解决代码组织中的**命名不合理、职责不清、内容混乱**问题。不以行数为驱动。

## 核心问题

### P0：路由与 UI 入口不一致（阻塞其他重构）

规范 UI 入口是 `/history/v3/`（Vite base、router hash base、E2E 测试、DESIGN.md 都指向它），
但后端路由只注册了 `/history`（只处理 `/` 和 `/assets/*`），没有 `/history/v3` 或 `/history/v3/assets/*`。
`/ui` 是未文档化的别名。这是**路由设计问题**，不是注释问题。

### P1：模块命名和职责混乱

- `history/store.ts` 混合了 33 个类型定义 + 状态管理 + CRUD + 查询 + 统计导出
- `history/api.ts` 是唯一不叫 `handler.ts` 的 handler 文件
- `ws/index.ts`（350 行业务逻辑）不是 barrel，却用了 barrel 命名
- `auto-truncate/index.ts`（425 行引擎代码）同上
- `system-prompt.ts` 和 `sanitize-system-reminder.ts` 逻辑相关但散落在 `lib/` 顶层
- WebSocket 路由在 `start.ts` 注册，不在 `routes/index.ts`，路由表分裂
- `usage/route.ts` 存在但未被 `routes/index.ts` 注册（git 显示曾被移除）

### P1：全局状态无纪律

`state.ts` 的 25+ 字段被 12 个文件直接赋值，无 setter、无追踪、无优先级文档。

### P1：测试可追踪性差

多个测试文件名与被测模块不对应，且部分测试同时覆盖多个模块。
项目使用 unit/component/integration/e2e 分层测试，不应强求一对一镜像。

### P2：前端双轨页面 + 大组件

5 legacy + 5 Vuetify 页面并存。Legacy `ModelsPage.vue`（713 行）比对应 Vuetify 版更大。

## 文档索引

| 文档 | 优先级 | 范围 |
|------|--------|------|
| [01-oversized-files.md](01-oversized-files.md) | P1 | 职责混合的大文件：按职责拆分 |
| [02-route-organization.md](02-route-organization.md) | P0 | `/history/v3` 入口一致性 + 路由命名 + WS 注册 + orphan route |
| [03-module-boundaries.md](03-module-boundaries.md) | P1 | 模块命名修正（ws、auto-truncate、system-prompt） |
| [04-test-alignment.md](04-test-alignment.md) | P1 | 测试可追踪性（非一对一镜像） |
| [05-state-management.md](05-state-management.md) | P1 | 全局状态写入面治理 |
| [06-frontend-cleanup.md](06-frontend-cleanup.md) | P2 | Legacy 标记废弃 + 大组件职责拆分 |
| [07-cross-cutting.md](07-cross-cutting.md) | P2 | 前后端类型耦合 + Vite proxy 硬编码 |

## 执行顺序

```
Phase 1: 02 路由入口（P0，阻塞其他路由相关改动）
Phase 2: 01 + 03 + 05（P1，可并行）
Phase 3: 04（P1，与 01 协调）
Phase 4: 06 + 07（P2）
```

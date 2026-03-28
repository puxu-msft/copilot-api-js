# 02 — 路由组织（P0）— 已完成

## 完成状态

| 任务 | 状态 |
|------|------|
| `/ui` 成为规范入口（vite base、router hash base、dist rebuild） | ✓ |
| API/UI 路由拆分（`history/route.ts` 只保留 API，新建 `ui/route.ts`） | ✓ |
| `registerHttpRoutes` / `registerWsRoutes` 拆分（消除 Symbol 守卫） | ✓ |
| `history/api.ts` → `handler.ts` 重命名 | ✓ |
| `usage/route.ts` 删除（用户确认） | ✓ |
| `/history` 根路径返回 404 | ✓ |
| 启动日志 URL 改为 `/ui` | ✓ |
| WS 路由归入 `registerWsRoutes` | ✓ |

## 验证

- [x] `dist/index.html` 资源引用 `/ui/assets/...`
- [x] `routes/index.ts` 导出 `registerHttpRoutes` + `registerWsRoutes`，无 Symbol 守卫
- [x] `server.ts` 调 `registerHttpRoutes`，`start.ts` 调 `registerWsRoutes`
- [x] `/history/v3` 零残留（后端 grep 确认）
- [x] E2E 测试路径全部 `/ui`
- [x] `typecheck` + `test:all` 通过

## 相关设计文档

- [02-v2-ui-entry.md](02-v2-ui-entry.md) — `/ui` 入口统一方案
- [02-v3-ws-registration.md](02-v3-ws-registration.md) — WS 注册拆分方案

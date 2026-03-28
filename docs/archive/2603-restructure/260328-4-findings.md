# 260328-4 审查：Phase 2 代码拆分与测试对齐质量

日期：2026-03-28（最终更新）

## 审查范围

本轮审查覆盖以下重构与对齐工作：

- `error.ts` → `error/` 目录化
- `context/request.ts` → 类型提取到 `context/types.ts`
- `anthropic/sanitize.ts` → 编排层 + 子模块拆分
- `history/store.ts` → 多职责文件拆分
- `anthropic/auto-truncate.ts` → 子模块拆分
- 路由：`/ui` 入口统一、API/UI 拆分、`registerHttpRoutes` / `registerWsRoutes` 拆分
- 测试：命名对齐、runner 边界清理、公共 E2E helper、package scripts 分层

## 验证结果

- `npm run typecheck` 通过
- `npm run typecheck:ui` 通过
- `bun test` 通过
- `npm run test:all` 通过
- `PLAYWRIGHT_BASE_URL=http://localhost:4242 npm run test:e2e-ui` 通过

## 已完成的改进

| 问题域 | 内容 | 状态 |
|--------|------|------|
| 02-v2 | `/ui` 入口统一（vite base、router hash base、route 拆分、dist rebuild） | ✓ 已完成 |
| 02-v3 | `registerHttpRoutes` / `registerWsRoutes` 拆分（消除 Symbol 守卫） | ✓ 已完成 |
| 04 | `copilot-headers.test.ts` → `copilot-api.test.ts` | ✓ 已完成 |
| 04 | `system-prompt-manager.test.ts` → `system-prompt-config-integration.test.ts` | ✓ 已完成 |
| 04 | Playwright 浏览器 E2E 从 Bun 默认测试发现中剥离 | ✓ 已完成 |
| 04 | `tests/e2e-ui` 公共入口 helper（`BASE_URL` / health check / `uiUrl()`） | ✓ 已完成 |
| 04 | package scripts 补齐测试分层入口与完整验收入口 | ✓ 已完成 |
| sanitize | 文本块系统提醒清洗逻辑提取为共享内部工具 | ✓ 已完成 |
| sanitize | `sanitize.ts` 继续瘦身，system prompt / content-block 辅助逻辑拆出 | ✓ 已完成 |
| history | `history/index.ts` 补齐缺失类型 re-export，并添加 contract test 防回退 | ✓ 已完成 |
| history | 搜索索引逻辑回归 `state.ts`，统计广播改为 history 层按需拉取 | ✓ 已完成 |
| error | `forward.ts` 去除对 `auto-truncate` / 全局 `state` 的向上依赖 | ✓ 已完成 |
| error | token-limit / retry-after / upstream-rate-limit 解析逻辑抽到 `error/parsing.ts` | ✓ 已完成 |
| error | `HTTPError` 恢复为纯错误类；`classify.ts` 导出面与 barrel 对齐 | ✓ 已完成 |
| history | `sessions.ts` import 顺序整理 | ✓ 已完成 |

## 最终结论

本轮审查中列出的结构问题已经全部处理完成。

此前的剩余问题主要集中在两类：

1. `history/` 与 `sanitize/` 子模块拆分后，仍残留少量兄弟模块互相依赖或编排层夹杂实现细节
2. `error/` 模块虽然目录化完成，但解析、分类、转发之间的职责边界还没有真正收口

现在这两类问题都已经收敛：

- `history/` 查询层不再反向依赖写入层
- `sanitize.ts` 已回到“编排 + 统计 + 日志”为主
- `error/forward.ts` 不再依赖 `auto-truncate` 特性层与全局运行时状态
- `error` 解析辅助逻辑已集中到独立模块，`HTTPError` / `classify` / `forward` 的职责边界清晰

## 当前状态

本次审查范围内，没有未关闭的结构问题。

如果后续还要继续优化，应该视为新的重构议题，而不是本轮 findings 的残留项。

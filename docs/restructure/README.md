# 代码重构规划

## 背景

前后端合并（docs/merge/）完成后，仓库统一为单 package.json 管理。
但代码组织层面存在系统性问题：超大文件、命名不一致、模块边界不清、测试文件名与源文件不对应。

## 当前状态

- **7 个文件超过 500 行**，最大 1189 行（违反 CLAUDE.md 的 800 行上限）
- 路由命名不统一：`history/api.ts` 是唯一不叫 `handler.ts` 的 handler 文件
- WebSocket 路由在 `start.ts` 注册而非 `routes/index.ts`，路由表分裂
- `ws/index.ts`（350 行）不是 barrel 却用了 barrel 命名
- 多个测试文件名与被测源文件不对应
- 全局状态 `state.ts` 25+ 可变字段，无 setter 纪律

## 优先级矩阵

| 优先级 | 文档 | 范围 | 依赖 |
|--------|------|------|------|
| **P0** | [01-oversized-files.md](01-oversized-files.md) | 拆分 7 个超限文件 | 无，可立即开始 |
| P1 | [02-route-organization.md](02-route-organization.md) | 路由命名 + WS 注册归位 | 无 |
| P1 | [03-module-boundaries.md](03-module-boundaries.md) | 模块命名和边界修正 | 建议在 02 之后 |
| P1 | [04-test-alignment.md](04-test-alignment.md) | 测试文件名对齐 | 与 01 协调（拆分后路径变化） |
| P1 | [05-state-management.md](05-state-management.md) | 全局状态治理 | 独立 |
| P2 | [06-frontend-cleanup.md](06-frontend-cleanup.md) | Legacy 页面标记废弃 + 大组件拆分 | 独立 |
| P2 | [07-cross-cutting.md](07-cross-cutting.md) | 类型耦合、静态服务、配置分散 | 独立 |

## 执行顺序

```
Phase 1（P0，独立可并行）:
  01 → 逐个文件拆分，每个文件一个 PR

Phase 2（P1，有序）:
  02 路由统一 → 03 模块边界 → 04 测试对齐
  05 状态治理 可与 02-04 并行

Phase 3（P2，P0+P1 完成后）:
  06 前端清理
  07 跨领域问题
```

## 原则

- 拆分后通过 barrel re-export 保持所有现有 import 路径不变
- 每个拆分目标文件 200-400 行，不超过 800 行
- 重命名通过 grep 确认所有 import 路径后再执行
- 每步完成后运行 `typecheck` + `test` 验证

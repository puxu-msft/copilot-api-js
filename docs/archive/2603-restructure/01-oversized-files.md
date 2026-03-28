# 01 — 职责混合的大文件（P1）— 已完成

**单文件承担了过多不相关职责**，导致命名无法反映内容、修改时牵连面过大。

## 完成状态

| 文件 | 状态 | 结果 |
|------|------|------|
| `history/store.ts` | ✓ 已完成 | → barrel（41 行），拆为 types/state/sessions/entries/queries/stats |
| `error.ts` | ✓ 已完成 | → barrel（1 行），拆为 error/http-error/classify/forward/utils/parsing |
| `anthropic/sanitize.ts` | ✓ 已完成 | → 编排层（135 行），拆为 7 个子模块 |
| `anthropic/auto-truncate.ts` | ✓ 已完成 | → 主入口（414 行），拆出 tool-utils/token-counting/truncation |
| `context/request.ts` | ✓ 已完成 | → 工厂（333 行），类型提取到 types.ts（198 行） |
| `openai/auto-truncate.ts` | ✓ 已完成 | → 主入口（462 行），拆出 token-counting/truncation |

## 未纳入的文件

`lib/adaptive-rate-limiter.ts`（558 行）：虽然体量较大，但内容是单一内聚的 `AdaptiveRateLimiter` 类 + 工厂函数，不存在职责混合问题。不拆分。

## 验证

- [x] 所有 barrel re-export 后 `import { X } from "~/lib/xxx"` 路径不变
- [x] `typecheck` + `typecheck:ui` + `test` + `test:ui` 通过

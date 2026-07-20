# 03 — 模块边界修正（P1）— 已完成

## 完成状态

| 任务 | 状态 | 结果 |
|------|------|------|
| `ws/index.ts`（业务逻辑）→ `ws/broadcast.ts` | ✓ | `ws/index.ts` 现在是 2 行 barrel |
| `ws-adapter.ts` → `ws/adapter.ts` | ✓ | 旧文件已删除 |
| `auto-truncate/index.ts`（引擎）→ `auto-truncate/engine.ts` | ✓ | `auto-truncate/index.ts` 现在是 1 行 barrel |
| `system-prompt.ts` → `system-prompt/override.ts` | ✓ | 旧文件已删除 |
| `sanitize-system-reminder.ts` → `system-prompt/reminder.ts` | ✓ | 旧文件保留为 1 行 re-export shim |
| `system-prompt/index.ts` 纯 barrel | ✓ | 2 行 |
| `shutdown.ts` 不拆分 | ✓ | 内聚性高，保持原样 |

## 残留 shim

`src/lib/sanitize-system-reminder.ts` 保留为 `export * from "./system-prompt/reminder"`。
3 个消费者（`anthropic/sanitize.ts`、`openai/sanitize.ts`、`auto-truncate/engine.ts`）仍通过旧路径导入。
后续可将消费者改为直接 import `~/lib/system-prompt`，然后删除 shim。

## 验证

- [x] `ws/` 重组后 `import { ... } from "~/lib/ws"` 不变
- [x] `auto-truncate/` 重命名后 import 不变
- [x] `system-prompt/` 分组后 import 不变
- [x] `typecheck` + `test` 通过

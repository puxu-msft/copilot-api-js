# 01 — 职责混合的大文件（P1）

**单文件承担了过多不相关职责**，导致命名无法反映内容、修改时牵连面过大。

## 职责混合最严重的文件

### 1. `lib/history/store.ts` — 类型 + 状态 + CRUD + 查询 + 统计

**问题**：文件名是 `store`，但实际包含 33 个类型定义、状态单例、session 管理、CRUD 操作、分页查询、统计导出。任何修改都需要在 1189 行中定位，且前端通过 `~backend/lib/history/store` 导入了 31 个类型。

**拆分方向**：按职责域分文件。

| 目标文件 | 职责 |
|----------|------|
| `history/types.ts` | 所有 type/interface 定义（L28-396，33 个） |
| `history/state.ts` | `historyState` 单例 + `initHistory` + `isHistoryEnabled` |
| `history/sessions.ts` | session 生命周期（create/get/delete） |
| `history/entries.ts` | entry CRUD（insert/update/get/evict/clear） |
| `history/queries.ts` | 查询与分页（getHistory/getSummaries/getSessionEntries） |
| `history/stats.ts` | 统计与导出（getStats/exportHistory） |
| `history/store.ts` | barrel re-export（保持 `"~/lib/history/store"` 和 `"~backend/lib/history/store"` 路径有效） |

### 2. `lib/error.ts` — Error 类 + 分类 + 转发 + 工具函数

**问题**：`HTTPError` 类、错误分类枚举、Hono context 绑定的 `forwardError`、通用工具函数混在一个 687 行的平铺文件中。

**拆分方向**：

| 目标文件 | 职责 |
|----------|------|
| `error/http-error.ts` | `HTTPError` 类 + `parseTokenLimitError` |
| `error/classify.ts` | `ApiErrorType` + `ApiError` + `classifyError` |
| `error/forward.ts` | `forwardError`（依赖 Hono Context） |
| `error/utils.ts` | `parseRetryAfterHeader` + `formatErrorWithCause` + `getErrorMessage` |
| `error/index.ts` | barrel re-export |

### 3. `lib/anthropic/sanitize.ts` — 4 个独立功能混在一起

**问题**：system-reminder 移除、tool blocks 处理、tool call 去重、read-tool 标签剥离——4 个有 `// ===` section 分隔的独立功能。文件名 `sanitize` 过于宽泛。

**拆分方向**：按已有 section 分隔拆文件，每个文件名反映具体功能。

### 4. `lib/anthropic/auto-truncate.ts` — tool 工具 + token 计数 + 截断算法

**问题**：tool ID 提取/orphan 过滤（与 truncation 无关的通用工具）、token 计数、截断策略混在一起。

**拆分方向**：`tool-utils.ts` + `token-counting.ts` + `truncation.ts`，`auto-truncate.ts` 保留为主入口。

### 5. `lib/context/request.ts` — 9 个接口 + 2 个类型别名 + 工厂函数

**问题**：类型定义（9 个 interface + 2 个 type alias）占一半篇幅，与工厂函数的实现逻辑混合。

**拆分方向**：`context/types.ts`（接口定义）+ `context/request.ts`（工厂函数）。

### 6. `lib/openai/auto-truncate.ts` — 与 anthropic 版对称的职责混合

**问题**：与 `anthropic/auto-truncate.ts` 结构相同——auto-truncate 主逻辑、limit 计算、message utilities、token 计数混在一起（755 行）。如果治理 anthropic 版而不治理 openai 版，会留下不一致。

**拆分方向**：与 anthropic 版对称——`token-counting.ts` + `truncation.ts`，`auto-truncate.ts` 保留为主入口。

## 通用策略

- 原文件变为 barrel re-export，所有现有 import 路径不变
- 每次拆分后运行 `typecheck` + `typecheck:ui` + `test`
- 拆分优先级：`history/store.ts`（影响前后端）> `error.ts`（被最多模块 import）> 其余

## 验证

- [ ] 所有 barrel re-export 后 `import { X } from "~/lib/xxx"` 路径不变
- [ ] `typecheck` + `typecheck:ui` + `test` + `test:ui` 通过

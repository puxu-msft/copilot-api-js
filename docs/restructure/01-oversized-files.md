# 01 — 超大文件拆分（P0）

CLAUDE.md 规定文件上限 800 行，推荐 200-400 行。以下 7 个文件违反此规则。

## 总览

| 文件 | 行数 | 导出数 | 拆分复杂度 |
|------|------|--------|-----------|
| `lib/history/store.ts` | 1189 | 52 | 高（类型+状态+CRUD+查询+统计） |
| `lib/anthropic/auto-truncate.ts` | 1091 | 16 | 中（已有 section 分隔） |
| `lib/anthropic/sanitize.ts` | 930 | 7 | 中（已有 section 分隔） |
| `lib/openai/auto-truncate.ts` | 755 | 9 | 中（结构同 anthropic） |
| `lib/error.ts` | 687 | 9 | 低（职责明确可分） |
| `lib/adaptive-rate-limiter.ts` | 558 | 7 | 低（单类+工厂函数） |
| `lib/context/request.ts` | 511 | 12 | 中（类型+工厂+状态机） |

## 通用策略

1. 创建目录（如果文件还不在子目录中）
2. 按职责拆分到多个文件
3. 原文件变为 barrel re-export（`export * from "./xxx"`）
4. 所有现有 `import { X } from "~/lib/xxx"` 路径不变
5. 运行 `typecheck` + `test` 验证

---

## 1. `lib/history/store.ts`（1189 行 → 6 个文件）

**当前职责**：30 个类型定义 + 状态单例 + session 管理 + CRUD + 查询/分页 + 统计/导出。

**拆分方案**：

| 目标文件 | 内容 | 预估行数 |
|----------|------|----------|
| `history/types.ts` | 30 个 type/interface 导出（L28-396 的所有类型定义） | ~370 |
| `history/state.ts` | `historyState` 单例、`initHistory`、`setHistoryMaxEntries`、`isHistoryEnabled`、内部 `sessions` Map | ~80 |
| `history/sessions.ts` | `getCurrentSession`、`getSessions`、`getSession`、`deleteSession` | ~120 |
| `history/entries.ts` | `insertEntry`、`updateEntry`、`getEntry`、`evictOldestEntries`、`clearHistory` | ~180 |
| `history/queries.ts` | `getHistory`、`getHistorySummaries`、`getSessionEntries`、`getSummary` | ~200 |
| `history/stats.ts` | `getStats`、`exportHistory`、`formatLocalTimestamp` | ~160 |

`history/store.ts` 变为纯 barrel：
```ts
export * from "./types"
export * from "./state"
export * from "./sessions"
export * from "./entries"
export * from "./queries"
export * from "./stats"
```

**注意**：前端通过 `~backend/lib/history/store` 导入 33 个类型。barrel re-export 保持此路径有效。

**内部依赖链**：`entries.ts` 和 `sessions.ts` 需要 import `state.ts` 中的 `historyState`；`entries.ts` 需要 import `./ws` 中的通知函数。拆分后内部导入用相对路径 `./state`。

---

## 2. `lib/anthropic/auto-truncate.ts`（1091 行 → 4 个文件）

**当前职责**：tool ID 提取 + orphan 过滤 + token 计数 + 截断算法。文件已有 `// ===` section 分隔。

**拆分方案**：

| 目标文件 | 内容 | 预估行数 |
|----------|------|----------|
| `anthropic/tool-utils.ts` | `getAnthropicToolUseIds`、`getAnthropicToolResultIds`、`ensureAnthropicStartsWithUser`、`filterAnthropicOrphanedToolResults`、`filterAnthropicOrphanedToolUse` | ~170 |
| `anthropic/token-counting.ts` | `contentToText`、`countMessageTokens`、`countSystemTokens`、`countMessagesTokens`、`countFixedTokens`、`countTotalTokens`、`countTotalInputTokens` | ~170 |
| `anthropic/truncation.ts` | 截断策略函数（L390-763，内部 helpers） | ~370 |
| `anthropic/auto-truncate.ts` | `autoTruncateAnthropic` 主入口 + `AnthropicAutoTruncateResult` 接口 | ~380 |

总计约 1090 行，每个文件均在 400 行以内。原 `auto-truncate.ts` 保留为主入口，不需要额外 barrel。

---

## 3. `lib/anthropic/sanitize.ts`（930 行 → 4 个文件）

**当前职责**：system-reminder 移除 + tool blocks 处理 + tool call 去重 + read-tool 标签剥离 + 预处理管道。已有 7 个 `// ===` section。

**拆分方案**：

| 目标文件 | 内容 | 预估行数 |
|----------|------|----------|
| `anthropic/sanitize-reminders.ts` | `removeAnthropicSystemReminders` + 内部 helpers（L27-165） | ~140 |
| `anthropic/sanitize-tools.ts` | `processToolBlocks` + 内部 helpers（L166-455） | ~290 |
| `anthropic/sanitize-dedup.ts` | `deduplicateToolCalls` + 内部 helpers（L457-668） | ~210 |
| `anthropic/sanitize.ts` | `stripReadToolResultTags`、`preprocessAnthropicMessages` 主管道 + barrel re-export | ~290 |

---

## 4. `lib/openai/auto-truncate.ts`（755 行 → 3 个文件）

结构与 anthropic 对称。

| 目标文件 | 内容 | 预估行数 |
|----------|------|----------|
| `openai/token-counting.ts` | token 计数函数 | ~200 |
| `openai/truncation.ts` | 截断策略 | ~300 |
| `openai/auto-truncate.ts` | 主入口 + 类型定义 | ~250 |

---

## 5. `lib/error.ts`（687 行 → 目录化）

**当前职责**：`HTTPError` 类 + token limit 解析 + 错误转发 + 错误分类 + retry-after 解析 + 格式化工具。

**拆分方案**：创建 `lib/error/` 目录。

| 目标文件 | 内容 | 预估行数 |
|----------|------|----------|
| `error/http-error.ts` | `HTTPError` 类 + `parseTokenLimitError` | ~140 |
| `error/forward.ts` | `forwardError`（Hono context 相关，最大单函数） | ~120 |
| `error/classify.ts` | `ApiErrorType`、`ApiError`、`classifyError` | ~170 |
| `error/utils.ts` | `parseRetryAfterHeader`、`formatErrorWithCause`、`getErrorMessage` | ~50 |
| `error/index.ts` | barrel re-export | ~10 |

原 `import { HTTPError } from "~/lib/error"` 路径通过 `error/index.ts` 保持有效。

---

## 6. `lib/adaptive-rate-limiter.ts`（558 行 → 目录化）

**当前职责**：配置接口 + `AdaptiveRateLimiter` 类（470 行）+ 工厂/单例函数。

**拆分方案**：创建 `lib/adaptive-rate-limiter/` 目录。

| 目标文件 | 内容 | 预估行数 |
|----------|------|----------|
| `adaptive-rate-limiter/types.ts` | `AdaptiveRateLimiterConfig`、`RateLimitedResult` 接口 | ~50 |
| `adaptive-rate-limiter/limiter.ts` | `AdaptiveRateLimiter` 类 | ~440 |
| `adaptive-rate-limiter/index.ts` | 工厂函数 + barrel re-export | ~70 |

注意：`limiter.ts` 仍有 440 行，但这是一个内聚的类，不宜再拆。

---

## 7. `lib/context/request.ts`（511 行 → 2 个文件）

**当前职责**：11 个类型/接口定义 + `createRequestContext` 工厂函数（含请求状态机逻辑）。

**拆分方案**：

| 目标文件 | 内容 | 预估行数 |
|----------|------|----------|
| `context/types.ts` | `RequestState`、`OriginalRequest`、`EffectiveRequest`、`WireRequest`、`ResponseData`、`Attempt`、`HeadersCapture`、`HistoryEntryData`、`RequestContextEventData`、`RequestContextEventCallback`、`RequestContext` | ~180 |
| `context/request.ts` | `createRequestContext` 工厂函数 | ~330 |

---

## 验证清单

每个文件拆分后：
- [ ] `npm run typecheck` 通过
- [ ] `npm run typecheck:ui` 通过（history/store.ts 的类型被前端消费）
- [ ] `npm run test` 通过
- [ ] `npm run test:ui` 通过
- [ ] 所有 `import { X } from "~/lib/xxx"` 路径不变（grep 验证）

# 260328-4 审查：Phase 2 代码拆分质量

日期：2026-03-28

## 审查范围

Codex 执行的 3 组拆分：`error.ts`、`context/request.ts`、`anthropic/sanitize.ts`，
以及后续的 `history/store.ts`、`anthropic/auto-truncate.ts`（部分）。

typecheck/typecheck:ui/test/test:ui 全绿，功能无回归。以下为代码质量层面的发现。

---

## HIGH

### H1. `anthropic/sanitize.ts` 与 `sanitize/system-reminders.ts` 存在逻辑重复

`src/lib/anthropic/sanitize.ts:94-118` 的 `sanitizeTextBlocksInArray` 与
`src/lib/anthropic/sanitize/system-reminders.ts:18-42` 实现完全相同。

子模块提取了这个函数，但编排层的副本没有删除。

**修复**：删除 `sanitize.ts` 中的副本，从 `./sanitize/system-reminders` import。

---

## MEDIUM

### M1. `history/` 兄弟模块互相依赖

| 依赖 | 文件:行 | 原因 |
|------|---------|------|
| `entries.ts` → `stats.ts` | `entries.ts:2` | 调 `getStats()` 传给 `notifyStatsUpdated()` |
| `sessions.ts` → `stats.ts` | `sessions.ts:3` | 同上 |
| `queries.ts` → `entries.ts` | `queries.ts:1` | 用 `ensureSearchText()` |

`ensureSearchText` 是懒构建搜索索引的辅助函数，逻辑上属于 `state.ts`（索引管理），不属于 `entries.ts`（写入层）。
只读的 `queries.ts` 因此被迫依赖写入层 `entries.ts`。

`getStats()` 依赖同理——`entries.ts` 和 `sessions.ts` 不应关心统计计算，
它们只需要触发"stats changed"通知，由 ws 层自行拉取 stats。

**建议**：
- 将 `ensureSearchText` 移到 `state.ts`
- 将 `notifyStatsUpdated(getStats())` 模式改为 `notifyStatsChanged()`，让 ws 层或消费者自行调 `getStats()`

### M2. `history/index.ts` 缺少 3 个类型 re-export

`store.ts` barrel 导出 33 个类型，但 `index.ts` 只 re-export 30 个。

缺少：`CursorResult`、`SseEventRecord`、`ServerToolResultContentBlock`

通过 `~/lib/history`（而非 `~/lib/history/store`）导入的消费者会缺少这些类型。
前端通过 `~backend/lib/history/store` 直接导入不受影响。

**修复**：在 `index.ts` 的类型 re-export 中补齐。

### M3. `anthropic/sanitize.ts` 编排层仍含可提取逻辑

编排层应只负责调用顺序和胶水代码，但当前仍包含：

| 函数 | 行 | 归属 |
|------|------|------|
| `sanitizeAnthropicSystemPrompt` | L37-56 | → `sanitize/system-reminders.ts` |
| `filterEmptyAnthropicTextBlocks` | L62-80 | → 新建 `sanitize/filter-empty-blocks.ts` 或留在编排层（体量小） |
| `filterEmptySystemTextBlocks` | L85-88 | 同上 |
| `countAnthropicContentBlocks` | L165-171 | 纯工具函数，可移入任一子模块或独立 |

H1 中的重复 `sanitizeTextBlocksInArray` 也属于这个问题的一部分。

### M4. `error/forward.ts` 向上依赖特性模块

| import | 文件:行 | 问题 |
|--------|---------|------|
| `tryParseAndLearnLimit` from `../auto-truncate` | `forward.ts:6` | auto-truncate 涉及磁盘 I/O 和校准状态 |
| `state` from `../state` | `forward.ts:7` | 读取 `state.autoTruncate` 运行时开关 |

错误转发层（底层基础设施）向上依赖应用特性层（auto-truncate），是分层违规。
这不是拆分引入的——原 `error.ts` 就有这个依赖。但拆分后更显眼。

**建议**：通过回调或策略模式解耦。`forwardError` 接受一个可选的 `onTokenLimitError` 回调，
由调用方（route handler）注入 auto-truncate 逻辑，而非 forward.ts 自己 import。

---

## MINOR

### m1. `parseTokenLimitError` 放置不当

`error/http-error.ts:23-47` 中的 `parseTokenLimitError` 是字符串解析器，与 `HTTPError` 类无关。
逻辑上属于 `utils.ts`。

### m2. `classify.ts` 有未通过 barrel 暴露的导出

`classify.ts:191` 导出 `isUpstreamRateLimited`，`classify.ts:213` 导出 `extractRetryAfterFromBody`。
两者都不在 `index.ts` 的 re-export 列表中。`forward.ts:8` 直接 import `./classify` 绕过 barrel。

如果这些是内部函数，应去掉 `export`；如果是公开 API，应加入 `index.ts`。

### m3. `sessions.ts` import 顺序不一致

`sessions.ts:1-4` 中 `./ws` 出现在 `./stats` 和 `./state` 之前，
与 `entries.ts` 的排列惯例（先 state/stats，后 ws）不一致。

---

## 未涉及的拆分

以下模块拆分通过 barrel 代理，结构简单，无需深度审查：

- `context/request.ts` → `context/types.ts`（198 行类型）+ `request.ts`（333 行工厂）——干净的类型/实现分离
- `anthropic/auto-truncate.ts` → `auto-truncate/tool-utils.ts` + `auto-truncate/token-counting.ts`——独立子功能提取，主文件保留编排

---

## 建议修复优先级

1. **H1** — 删除重复函数（1 分钟修复）
2. **M2** — 补齐 `index.ts` re-export（1 分钟修复）
3. **M1** — 移动 `ensureSearchText` 到 `state.ts`（需验证 queries.ts 测试）
4. **M3** — sanitize 编排层继续瘦身（与 H1 一起做）
5. **M4** — forward.ts 解耦（改动面较大，可后续单独处理）

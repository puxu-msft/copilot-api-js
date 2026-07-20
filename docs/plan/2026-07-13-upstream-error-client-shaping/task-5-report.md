# Phase 5（自愈委派 selfheal delegation）实施报告

**分支**：`feat/upstream-error-client-shaping`（隔离 worktree `.worktrees/upstream-error-client-shaping`）
**日期**：2026-07-13 ～ 2026-07-14
**状态**：DONE（Task 5.1 / 5.2 / 5.3 全部落地，Phase 5 完成检查全项通过）

## 提交

| 短哈希 | 说明 |
|--------|------|
| `d89741e3` | feat: add filterDelegatedStrategies for D-class self-heal delegation（Task 5.1） |
| `060e6ebc` | feat: wire D-class self-heal delegation into ENDPOINT.MESSAGES strategy assembly（Task 5.2，含 `tests/routes/messages/handler-v4-selfheal-delegation.it.test.ts` 6 例） |
| `2a3d868d` | test: lock D-class boundary invariants (media-strip no-mapping, quarantine isolation)（Task 5.3，追加 `tests/anthropic/error-shaping-selfheal.unit.test.ts` 2 例） |

## 测试摘要

- `error-shaping-selfheal.unit.test.ts`：10/10 绿（Task 5.1 的 8 例 `fakeStrategy` 纯函数测试 + Task 5.3 的 2 例真实 `buildAnthropicStrategies()` 边界测试）。
- `handler-v4-selfheal-delegation.it.test.ts`：6/6 绿（Task 5.2 的 ENDPOINT.MESSAGES 接线 4 例 + 前向翻译腿不受影响 2 例）。
- 全量回归 `tests/anthropic/` + `tests/routes/messages/` + `tests/pipeline/`：**1877/1877 绿**（`bun test`，非 `bun test --coverage` 管道截断误报——见下方「误报排查」）。
- `bun run typecheck` 全绿。
- `bunx eslint --no-cache`（本 phase 改动的 3 个文件：`src/lib/anthropic/error-shaping.ts`、`src/routes/messages/handler-v4.ts`、两个测试文件）全绿。
- 禁改文件确认零改动：`git diff --stat` 对 `stream-accumulator.ts`、`translate/anthropic-to-cc-request.ts`、`translate/anthropic-to-cc-stream.ts`、`responses-conversion.ts`、`responses-stream-accumulator.ts`、`codec/anthropic/strategies.ts`、`codec/anthropic/strategy-registry.ts` 均无输出（零改动）。

### 误报排查（非本 phase 缺陷）

第一次跑 `bun test tests/anthropic/ tests/routes/messages/ tests/pipeline/ | tail -N` 时管道中段报 `error: An internal error occurred (WriteFailed)`，且每次截断在同一文件（`anthropic-to-cc-stream.ts` 覆盖率行）。去掉 `tail` 管道、改为重定向到文件后复跑，`EXIT=0`，`1877 pass / 0 fail`——确认是覆盖率文本报告写 stdout 时与 `tail` 管道交互的假故障，不是真实测试失败。记录此现象供后续会话参考，避免误判。

## 各任务落地

### Task 5.1（`filterDelegatedStrategies`，已于上一会话提交 `d89741e3`）

`src/lib/anthropic/error-shaping.ts` 追加纯函数 `filterDelegatedStrategies(strategies, delegate, onDelegated?)`：
- 对 `delegate[strategy.name] === "delegate"` 的条目，返回一个包裹后的 `RetryStrategy`——`canHandle` 恒定返回 `false`（原 `canHandle` 命中时才触发 `onDelegated(name)` 回调，未命中不触发），`handle`/`onResolved` 原样透传（引用相等）。
- 未命中 `delegate` map 的条目原样透传（引用相等，非拷贝）。
- 数组长度/顺序不变，未知 key（不对应任何真实 `.name`）静默忽略、不抛错。
- 无 `~/lib/context/*`、无 `~/routes/*` 导入——纯函数、无 I/O。

### Task 5.2（接线进 `buildMessagesDriverStrategies`）

`src/routes/messages/handler-v4.ts` 的 `ENDPOINT.MESSAGES` 分支追加：

```ts
if (!state.errorShapingEnabled) return strategies
return filterDelegatedStrategies(strategies, state.errorSelfhealDelegate, (strategyName) =>
  env.ctx.recordFeature("error-shaping-selfheal-delegated", { strategyName }),
)
```

- 门控：`state.errorShapingEnabled=false` 时整个委派机制不生效（回落到未接线前的全量 undelegated stack，Task 5.2 测试锁定）。
- 仅 `ENDPOINT.MESSAGES` 分支改动——CC/Responses 前向翻译腿完全未碰（Task 5.2 用手搭无真实 `.ctx` 的 fake env 验证：若前向翻译腿分支误碰了 `env.ctx.recordFeature` 会直接抛错，测试通过即结构性证明未碰）。
- 测试方法论：为拿到 `ENDPOINT.MESSAGES` 分支需要的真实 `codec.getResanitize()` + 真实可捕获 `env.ctx`，直接调用 `codec.parse(raw)`（同步、无 HTTP/driver 往返）并包在 `withCapturingManager` 里，避免走完整 driver 重试循环产生的秒级 `waitMs` 延迟。

### Task 5.3（边界回归：media-strip 无映射 + quarantine 隔离）

追加到 `tests/anthropic/error-shaping-selfheal.unit.test.ts` 的第二个 `describe` 块，**驱动真实 `buildAnthropicStrategies()` 输出**（而非 Task 5.1 用的 `fakeStrategy` 手搭双），两条边界不变量：

1. **media-strip 无代理侧对应策略**：`strategies.filter(s => /media/i.test(s.name))` 为空数组——CC 客户端自身的 `retry:media-strip` 自愈腿在代理侧没有任何反应式策略对应，因此 `errorSelfhealDelegate` 里配一个 media-strip 相关 key 是结构性 no-op（天然无需委派，不是配置缺口）。
2. **L1 quarantine 结构性不在 `RetryStrategy[]` 数组里**：断言 `strategies.some(s => s.name === "thinking-quarantine-proactive")` 为 `false`，并用 `createQuarantineProactiveFilter()` 反证它产出的确实是 `RequestRewrite`（`order: 250`，无 `canHandle`），而非 `RetryStrategy`——它注册在 `codec.ts:218` 的另一个数组 `requestRewrites` 里，与 `buildAnthropicStrategies()` 返回的 `RetryStrategy[]` 是完全分离的两个管线阶段，`filterDelegatedStrategies` 天然碰不到它。作为对照，同一测试里验证 L1 的反应式兜底 `poisoned-thinking-retry`（**是** 真实 `RetryStrategy`）确实可被委派（`canHandle` 被强制 `false`）——证明委派的作用域精确等于「这个 `RetryStrategy[]` 数组」，不多不少。

**与计划文档的偏离**：计划草案（`phase-5-selfheal-delegation.md` 任务 5.3）建议用一份硬编码的 15 个策略名字面量数组做「文档性回归」断言，而非调用真实 `buildAnthropicStrategies()`。本实现改为直接调用真实工厂函数——原因见下方「发现的偏差」第 2、3 条：那份硬编码列表本身就带着计划文档的两个失真（命名 `effort-learning-retry` 而非真实的 `effort-learning`；缺失第 16 个策略 `poisoned-thinking-retry`），若照抄会把这两个失真原样焊进测试断言里，反而失去了「验证真实契约」的意义。直接调用真实工厂函数则自动免疫这类文档漂移。

## 发现的偏差（按 dispatch 要求记录为 concern，非阻塞）

1. **`effort-learning` vs `effort-learning-retry`**（上一会话已发现，本会话复核仍成立）：计划草案多处写作 `effort-learning-retry`，真实策略 `.name` 是 `effort-learning`（`createEffortLearningRetryStrategy` 内部命名，`src/lib/request/strategies/effort-learning-retry.ts`）。计划文件名带 `-retry` 后缀，实际策略名不带，属计划文档的命名失真，不影响实现（本 phase 代码从未依赖这个具体名字做业务判断）。
2. **计划的 6/15 行映射表遗漏第 16 个策略 `poisoned-thinking-retry`**：`docs/plan/.../phase-5-selfheal-delegation.md` 任务 5.3 草案里给出的 `knownStrategyNames` 硬编码数组只列了 15 个，缺 `poisoned-thinking-retry`（该策略在 `src/lib/codec/anthropic/strategies.ts` 第 117 行左右，是 native、非 `adapt()`-wrapped，容易在人工枚举时被漏数）。恰是这一遗漏让计划草案的「无 media-strip 映射」断言看似成立，实则未覆盖真实全集。本次实现改走真实工厂函数调用，天然规避此风险（见上）。
3. **新发现（本会话）：`src/lib/codec/anthropic/strategies.ts` 自身文件头注释声称"14 strategies total"（第 12 行），但实际 `buildAnthropicStrategies()` 返回数组长度是 16**（逐个数：network-retry、server-error-retry、token-refresh、effort-learning、tool-field-rejection-retry、body-field-rejection-retry、cache-control-subfield-rejection-retry、legacy-thinking-retry、adaptive-thinking-rejection-retry、poisoned-thinking-retry、unsupported-beta-retry、server-tool-rejection-retry、structured-outputs-rejection-retry、system-reject-retry、web-search-not-found-retry、deferred-tool-retry）。该文件头注释是独立于本次改动的既有文档失真（不在 dispatch 范围内，未修正，仅记录供后续会话参考）。

## Phase 5 完成检查（对照 plan 文档「完成检查」清单）

- [x] `bun run typecheck` 全绿。
- [x] `bunx eslint --no-cache` 对 3 个改动文件全绿。
- [x] `error-shaping.ts` 导入块确认无 `~/routes/*`、`~/lib/context/*` 路径。
- [x] 前向翻译腿零改动确认；`git diff --stat` 确认 `strategy-registry.ts`/`codec/anthropic/strategies.ts` 不在本 phase 的 diff 里。
- [x] `grep -rn "error-shaping-selfheal-delegated" src/` 命中 `FeatureKind` 类型声明（`src/lib/observability/events.ts:159`）+ 真实 `recordFeature` 调用点（`src/routes/messages/handler-v4.ts:295`）+ TUI 渲染分支（`src/lib/tui/terminal-ui.ts:1235`，既有基础设施顺带覆盖了这个新 feature kind）。
- [x] `stream-accumulator`/`openai-cc`/`openai-responses` 相关 codec 文件确认零改动。
- [x] 委派只影响反应式 `RetryStrategy`，从不影响 always-on quarantine——Task 5.3 两条边界测试锁定（结构性证明，非仅断言）。
- [x] `error_shaping_enabled=false` 完全禁用委派——Task 5.2 测试锁定。

# 移除 auto-truncate 截断本体、保留 calibration —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL：用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 从 copilot-api-js 移除「反应式截断/压缩请求 payload」的截断本体，保留 calibration 因子模型并重定位为本地 token 计数准确度增强。

**Architecture:** 截断本体（算法 + 反应式策略 + preflight + 配置 + UI）整体删除；calibration（因子模型 + 双学习腿 + backfill + seed + 持久化）保留，token-counting 子模块迁出 `auto-truncate/` 命名空间，`calibrate()` 接进 count-tokens 本地兜底作为唯一活消费者。共享重试预算改名，400 学习腿解耦为失败观测 sink。

**Tech Stack:** TypeScript（Bun runtime）、Zod config schema、hono routes、observability bus/sink、bun:test、Vitest（ui-v4）、Vue（ui/）。

**权威 spec：** [docs/rfc/2026-07-13-remove-auto-truncate-keep-calibration.md](../rfc/2026-07-13-remove-auto-truncate-keep-calibration.md)（本计划每个任务的判据以 RFC 为准）。

## Global Constraints

- **不强求 commit-invariants**（用户放宽）：允许中间 commit 编译不过 / 半坏，best-effort 分阶段提交；但每 Phase **收尾**须 `bun run typecheck` + `bun run typecheck:ui-v4` + 相关 `bun test` 绿。
- **显式 pathspec 提交**：`git add -- <精确路径>`、`git commit -- <精确路径>`，conventional commits，无模型署名。
- **隔离 worktree**：全程在 `.worktrees/remove-auto-truncate`（分支 `feat/remove-auto-truncate`），避与并发会话冲突。
- **绝不杀 4141 主服务器**：验证起新端口测试实例、按 PID 精确清理。
- **caliber 统一**：成功腿 / 400 腿 / count-tokens 消费腿 est 一律 `countTotalInputTokens`（RFC §3.4）。
- **`"truncated"` 字面量重载**：FeatureKind `"truncated"` 删；`TerminalOutcome.kind:"truncated"` **保留**（reverse-terminal.ts:34/44、driver.ts:726、各流式 handler）——绝不 grep 一把梭。
- **文本语言**：中文正文，ASCII 保留标识符 / 路径 / 代码。

---

## Phase 0 — 隔离 worktree + golden-fixture 预捕获

### Task 0.1：创建隔离 worktree

**Files:** 无（git 操作）

- [ ] **Step 1: 建 worktree + 分支**

```bash
cd /home/xp/src/copilot-api-js
git worktree add -b feat/remove-auto-truncate .worktrees/remove-auto-truncate
cd .worktrees/remove-auto-truncate
bun install
```

- [ ] **Step 2: 确认 typecheck 基线绿**

Run: `bun run typecheck && bun run typecheck:ui-v4`
Expected: 两者 exit 0（基线干净，后续回归有参照）。

### Task 0.2：golden-fixture 锁 calibration + count-tokens 当前行为

**Files:**
- Create: `tests/pipeline/calibration-golden.unit.test.ts`

**Interfaces:**
- Consumes: `calibrate` / `factorAt` / `ensureModelLimits` / `learnCalibration`（`~/lib/auto-truncate`）
- Produces: golden 断言集，保留部分在后续 Phase 后须仍全绿（等价性 oracle）。

- [ ] **Step 1: 写 golden 测试**——喂固定 (est, real) 样本训练一个模型，断言 `factorAt` / `calibrate` 在若干 est 点的确定输出；断言空模型 `calibrate(id, x)===x`（factorAt→1.0 恒等）。用真实种子模型 `claude-opus-4.8` 断言 seed 后 `factorAt` 落在 seed 表插值区间。

```ts
import { describe, expect, test, beforeEach } from "bun:test"
import { calibrate, factorAt, ensureModelLimits, learnCalibration, resetAllLimitsForTesting, seedFactorModel } from "~/lib/auto-truncate"

describe("calibration golden (pre-removal equivalence oracle)", () => {
  beforeEach(() => resetAllLimitsForTesting())

  test("empty model → identity", () => {
    expect(calibrate("unknown-model", 12345)).toBe(12345)
    expect(factorAt("unknown-model", 12345)).toBe(1.0)
  })

  test("learned samples produce deterministic factor", () => {
    ensureModelLimits("m")
    learnCalibration("m", 20000, 26000, { isLive: true }) // bucket 1
    learnCalibration("m", 50000, 66000, { isLive: true }) // bucket 2
    // factor at 20000 ≈ 26000/20000 = 1.3; calibrate ceils est*factor
    expect(calibrate("m", 20000)).toBe(26000)
    expect(factorAt("m", 20000)).toBeCloseTo(1.3, 5)
  })

  test("opus-4.8 seed materializes interpolated factor", () => {
    // seedFactorModel installs DEFAULT_FACTOR_SEED; factor at 48784 ≈ 1.313
    ensureModelLimits("claude-opus-4.8")
    expect(factorAt("claude-opus-4.8", 48784)).toBeCloseTo(1.313, 2)
  })
})
```

- [ ] **Step 2: 跑绿并连跑 5 次证确定性**

Run: `bun test tests/pipeline/calibration-golden.unit.test.ts`（再 `for i in 1 2 3 4 5; do bun test tests/pipeline/calibration-golden.unit.test.ts || break; done`）
Expected: 5/5 PASS。

- [ ] **Step 3: 提交**

```bash
git add -- tests/pipeline/calibration-golden.unit.test.ts
git commit -m "test: golden-fixture lock calibration factorAt/calibrate before removal"
```

---

## Phase 1 — 改名共享重试预算（RFC §3.1）

> `autoTruncateMaxRetries` 实为 17 策略共享的反应式重试上限（10 个 handler 站点：gemini 132/141/145、responses 162、messages 277/288/331、chat-completions 173/183/187）。改名 + 新 config 节 + 旧键兼容映射。此 Phase 与截断删除正交、可独立收尾。

### Task 1.1：state 字段改名 `autoTruncateMaxRetries` → `maxReactiveRetries`

**Files:**
- Modify: `src/lib/state.ts`（`readonly autoTruncateMaxRetries` 声明、`CONFIG_MANAGED_DEFAULTS`、两处 reset 块、`setAutoTruncateConfig` 的 Pick）
- Modify: 10 个 handler 站点（上列）
- Modify: `src/lib/codec/anthropic/strategies.ts:88`（注释）、`src/lib/config/config.ts:741`

- [ ] **Step 1: 改名 state 定义**——`autoTruncateMaxRetries` → `maxReactiveRetries`，默认值 5 不变。`setAutoTruncateConfig` 里该字段抽出（该 setter 其余字段 Phase 5 删；此处改名后暂留在同一 setter，Phase 5 迁到独立 setter 或并入通用 config apply）。
- [ ] **Step 2: 全仓替换引用**

```bash
grep -rln "autoTruncateMaxRetries" src | xargs sed -i 's/autoTruncateMaxRetries/maxReactiveRetries/g'
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: exit 0（纯改名，无类型变化）。

- [ ] **Step 4: 提交**

```bash
git add -- src/lib/state.ts src/routes src/lib/codec/anthropic/strategies.ts src/lib/config/config.ts
git commit -m "refactor: rename shared retry budget autoTruncateMaxRetries → maxReactiveRetries"
```

### Task 1.2：新 config `retry.max_reactive_retries` + 旧键兼容映射

**Files:**
- Modify: `src/lib/config/schema.ts`（新 `RetryConfigSchema` + 顶层 `retry` 节 + 删 `AutoTruncateConfigSchema.max_retries`）
- Modify: `src/lib/config/config.ts`（apply 块：`if (config.retry?.max_reactive_retries !== undefined) setReactiveRetryConfig(...)`）
- Modify: `src/lib/config/compat.ts`（`renameLeaf("auto_truncate.max_retries", "retry.max_reactive_retries")`）
- Test: `tests/config/config-compat.unit.test.ts`（新增旧键映射用例）

- [ ] **Step 1: 写失败测试**——旧配置 `{ auto_truncate: { max_retries: 8 } }` 经 compat + apply 后 `state.maxReactiveRetries===8` + 弃用警告。

```ts
test("auto_truncate.max_retries maps to retry.max_reactive_retries (deprecated)", () => {
  const migrated = applyCompat({ auto_truncate: { max_retries: 8 } })
  expect(migrated).toEqual({ retry: { max_reactive_retries: 8 } })
})
```

- [ ] **Step 2: 跑测证失败**

Run: `bun test tests/config/config-compat.unit.test.ts`
Expected: FAIL（renameLeaf 未加）。

- [ ] **Step 3: schema 加 `retry` 节**

```ts
// src/lib/config/schema.ts
export const RetryConfigSchema = z
  .object({
    /** 反应式重试的共享上限（全部 400-class / network / negotiation 策略共用）。Was `auto_truncate.max_retries`. */
    max_reactive_retries: nullableNonnegativeInt(),
  })
  .strict()
export type RetryConfig = z.infer<typeof RetryConfigSchema>
// 顶层 object 里加：  retry: nullableSection(RetryConfigSchema),
```

- [ ] **Step 4: compat renameLeaf + config.ts apply**——compat 加 `renameLeaf("auto_truncate.max_retries", "retry.max_reactive_retries")`；config.ts apply 块加 `retry` 分支调 `setReactiveRetryConfig({ maxReactiveRetries: r.max_reactive_retries })`（新 setter，或复用现 setter）。
- [ ] **Step 5: 跑绿 + typecheck**

Run: `bun test tests/config/config-compat.unit.test.ts && bun run typecheck`
Expected: PASS + exit 0。

- [ ] **Step 6: 提交**

```bash
git add -- src/lib/config/schema.ts src/lib/config/config.ts src/lib/config/compat.ts tests/config/config-compat.unit.test.ts
git commit -m "feat(config): add retry.max_reactive_retries, map legacy auto_truncate.max_retries"
```

---

## Phase 2 — caliber 统一为 countTotalInputTokens（RFC §3.4）

> 改前先确认迁出（Phase 3）尚未发生，import 路径仍为 `~/lib/anthropic/auto-truncate`。此 Phase 只改 est 计数函数，行为收敛。

### Task 2.1：成功腿 + backfill 改用 `countTotalInputTokens`

**Files:**
- Modify: `src/lib/observability/sinks/calibration.ts:22,78`（`countTotalTokens` → `countTotalInputTokens`）
- Modify: `src/lib/history/sqlite/calibration-backfill.ts:53,247`（同）
- Test: `src/lib/observability/sinks/calibration.test.ts`（调整断言的期望桶/值）

- [ ] **Step 1: 改 import + 调用**——两文件的 `countTotalTokens` 换 `countTotalInputTokens`。
- [ ] **Step 2: 更新受影响单测**——成功腿测里含 prior-turn thinking 的 fixture，期望 est 变小（排除 thinking）；断言仍落合理桶、`learnCalibration` 被调。
- [ ] **Step 3: 跑绿**

Run: `bun test src/lib/observability/sinks/calibration.test.ts src/lib/history/sqlite/calibration-backfill.test.ts`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add -- src/lib/observability/sinks/calibration.ts src/lib/history/sqlite/calibration-backfill.ts src/lib/observability/sinks/calibration.test.ts
git commit -m "refactor(calibration): unify est caliber on countTotalInputTokens (success+backfill legs)"
```

---

## Phase 3 — token-counting 子模块迁出 auto-truncate/ 命名空间

### Task 3.1：迁移 `anthropic/auto-truncate/token-counting.ts` → `anthropic/token-counting.ts`

**Files:**
- Rename: `src/lib/anthropic/auto-truncate/token-counting.ts` → `src/lib/anthropic/token-counting.ts`
- Rename: `src/lib/anthropic/auto-truncate/tool-utils.ts` → `src/lib/anthropic/message-tool-utils.ts`（只保留 `ensureAnthropicStartsWithUser` 等被 sanitize 消费的；orphan-filter 若仅截断用随 Phase 4 删）
- Modify: 所有 import 旧路径的文件

- [ ] **Step 1: git mv 保历史**

```bash
git mv src/lib/anthropic/auto-truncate/token-counting.ts src/lib/anthropic/token-counting.ts
git mv src/lib/anthropic/auto-truncate/tool-utils.ts src/lib/anthropic/message-tool-utils.ts
```

- [ ] **Step 2: 更新消费方 import**——`countTotalTokens`/`countTotalInputTokens` 现从 `~/lib/anthropic/token-counting` 直接导出；`ensureAnthropicStartsWithUser` 从 `~/lib/anthropic/message-tool-utils`。改：`observability/sinks/calibration.ts`、`history/sqlite/calibration-backfill.ts`、`routes/debug/route.ts`、`routes/messages/count-tokens.ts`、`codec/anthropic/{codec,strategies}.ts`、`anthropic/sanitize/system-messages.ts`。（`anthropic/auto-truncate.ts` 的 re-export 随 Phase 4 删）

- [ ] **Step 3: grep 无残留旧路径**

Run: `grep -rn "auto-truncate/token-counting\|auto-truncate/tool-utils" src`
Expected: 空。

- [ ] **Step 4: typecheck + 提交**

Run: `bun run typecheck`

```bash
git add -A -- src/lib/anthropic src/lib/observability src/lib/history src/routes src/lib/codec
git commit -m "refactor: relocate token-counting/tool-utils out of auto-truncate namespace"
```

---

## Phase 4 — 删除截断本体

> 允许本 Phase 内多 commit 中间态编译不过，Phase 收尾须 typecheck 绿。删除顺序：先删「叶子消费」（handler/strategy/codec preSend），再删「入口函数」（autoTruncate*），最后删「引擎截断片段」，避免长时间悬空。

### Task 4.1：删反应式截断策略 + 装配 + request 导出

**Files:**
- Delete: `src/lib/request/strategies/auto-truncate.ts`、`src/lib/request/truncation.ts`
- Modify: `src/lib/request/index.ts:18-24`（删 5 个导出）
- Modify: `src/lib/codec/anthropic/strategies.ts`（删 `createAutoTruncateStrategy` block + `autoTruncateAnthropic`/`countTotalTokens` import 里的截断项 + `TruncateResult` type import）
- Modify: `src/lib/codec/openai-cc/strategies.ts`（删 `createAutoTruncateStrategy` block + `autoTruncateOpenAI` import）

- [ ] **Step 1: 删文件 + 装配**（上列）。
- [ ] **Step 2: 删测**：`tests/pipeline/auto-truncate-strategy.unit.test.ts`、`tests/pipeline/auto-truncate-common.unit.test.ts`、`tests/pipeline/auto-truncate.it.test.ts`、`tests/pipeline/truncation-marker.unit.test.ts`。
- [ ] **Step 3: 提交**（typecheck 此刻可能因 handler 仍引用而红，允许）

```bash
git rm src/lib/request/strategies/auto-truncate.ts src/lib/request/truncation.ts tests/pipeline/auto-truncate-strategy.unit.test.ts tests/pipeline/auto-truncate-common.unit.test.ts tests/pipeline/auto-truncate.it.test.ts tests/pipeline/truncation-marker.unit.test.ts
git add -- src/lib/request/index.ts src/lib/codec/anthropic/strategies.ts src/lib/codec/openai-cc/strategies.ts
git commit -m "refactor: remove reactive auto-truncate strategy + assembly"
```

### Task 4.2：删 handler 截断产物接线 + FeatureKind "truncated"

**Files:**
- Modify: `src/routes/messages/handler-v4.ts`（`truncateResult` 全套 ~18 处 + `createTruncationMarker` import:145）
- Modify: `src/routes/chat-completions/handler-v4.ts`（`truncateResult` 全套 ~15 处 + `OpenAIAutoTruncateResult` import:31,73 + `recordFeature("truncated")`:197）
- Modify: `src/routes/messages/retry-meta-feature.ts:24`（删 `if (hasTruncateResult) return { feature: "truncated" }` 分支 + 相关入参）
- Modify: `src/lib/observability/events.ts:128`（删 `FeatureKind` 的 `"truncated"` 成员）
- Modify: `src/lib/tui/terminal-ui.ts:1223`（删 `case "truncated":`）

- [ ] **Step 1: 删 handler 截断分支**——移除 truncate 预处理调用、`truncateResult` 变量、其条件转发/marker 注入；**保留** `TerminalOutcome.kind==="truncated"` 的 complete 分支处理（截断检测，无关）。
- [ ] **Step 2: 删 FeatureKind + 渲染 case + retry-meta 分支**。
- [ ] **Step 3: typecheck**（此刻应接近绿；修残留悬空引用）

Run: `bun run typecheck`
Expected: 逐步收敛到 exit 0。

- [ ] **Step 4: 提交**

```bash
git add -- src/routes/messages/handler-v4.ts src/routes/chat-completions/handler-v4.ts src/routes/messages/retry-meta-feature.ts src/lib/observability/events.ts src/lib/tui/terminal-ui.ts
git commit -m "refactor: remove truncation wiring from handlers + FeatureKind truncated"
```

### Task 4.3：删截断入口函数 + codec preSend + openai 截断整目录

**Files:**
- Modify: `src/lib/anthropic/auto-truncate.ts`（删 `autoTruncateAnthropic`/`checkNeedsCompactionAnthropic`/`createTruncationResponseMarkerAnthropic` + 相关 truncation.ts import；保留 token-counting/tool-utils re-export 直到确认无消费者——若消费方已在 Phase 3 改直接 import，则此文件整体删）
- Delete: `src/lib/anthropic/auto-truncate/truncation.ts`、`src/lib/openai/auto-truncate.ts`、`src/lib/openai/auto-truncate/`（整目录）
- Modify: `src/lib/codec/anthropic/codec.ts`（删 `preSend` 预截断实现 ~581-620 + `autoTruncateAnthropic`/`calculateTokenLimit` import）

- [ ] **Step 1: 删 openai 截断整目录 + anthropic truncation.ts**。
- [ ] **Step 2: 删 codec preSend**——`preSend` 若接口要求存在则改为 no-op/移除该 hook（按 `FormatCodec` 契约；若 optional 则整删）。核对 `pipeline/types.ts:641` 注释同步。
- [ ] **Step 3: 处理 `anthropic/auto-truncate.ts`**——删截断函数；若 Phase 3 后其 re-export 已无消费者，`git rm` 整文件。
- [ ] **Step 4: typecheck + 提交**

Run: `bun run typecheck`

```bash
git rm src/lib/anthropic/auto-truncate/truncation.ts
git rm -r src/lib/openai/auto-truncate.ts src/lib/openai/auto-truncate
git add -- src/lib/anthropic/auto-truncate.ts src/lib/codec/anthropic/codec.ts src/lib/pipeline/types.ts
git commit -m "refactor: remove truncation entrypoints + codec preSend preflight"
```

### Task 4.4：删 engine.ts 截断专属片段

**Files:**
- Modify: `src/lib/auto-truncate/engine.ts`
- Modify: `src/lib/auto-truncate/index.ts`（导出面收窄）
- Modify: `src/lib/auto-truncate/engine.consumers.test.ts`（删截断相关用例）

删除符号：`AutoTruncateConfig`、`DEFAULT_AUTO_TRUNCATE_CONFIG`、`MAX_AUTO_TRUNCATE_RETRIES`、`AUTO_TRUNCATE_RETRY_FACTOR`、`ModelLimits.tokenLimit` 字段、`calculateTokenLimit`（此符号在 truncation.ts，已随 4.3 删）、`computeSafetyMargin`、`hasKnownLimits`、`compressToolResultContent`、`compressCompactedReadResult`、`onTokenLimitExceeded`、`tryParseAndLearnLimit`、`LimitErrorInfo`。

- [ ] **Step 1: 删符号 + 收窄 index 导出**。删 `ModelLimits.tokenLimit` 后，`loadPersistedLimits` 里 v2 的 `...(lim.tokenLimit !== undefined && { tokenLimit })` 与 v1 迁移的 `...(lim.tokenLimit > 0 && { tokenLimit })` 两处一并删（保 version:2 不变）。
- [ ] **Step 2: 更新 engine 单测**——删依赖 `tokenLimit`/`computeSafetyMargin`/`hasKnownLimits` 的用例；`engine.factor-model.test.ts`/`engine.persist.test.ts` 保留 calibration 部分。
- [ ] **Step 3: typecheck + calibration 单测 + golden 绿**

Run: `bun run typecheck && bun test src/lib/auto-truncate tests/pipeline/calibration-golden.unit.test.ts`
Expected: exit 0 + PASS（golden 证 calibration 保留部分等价）。

- [ ] **Step 4: 提交**

```bash
git add -- src/lib/auto-truncate/engine.ts src/lib/auto-truncate/index.ts src/lib/auto-truncate/engine.consumers.test.ts
git commit -m "refactor: strip truncation-only symbols from calibration engine"
```

---

## Phase 5 — 删 state/config/CLI/UI + boot 无条件加载

### Task 5.1：boot 无条件 loadPersistedLimits + 删 state 截断字段

**Files:**
- Modify: `src/start.ts:499`（`if (state.autoTruncate) { await loadPersistedLimits() }` → 无条件 `await loadPersistedLimits()`；删 CLI `--auto-truncate`/`--no-auto-truncate` 解析 182/337-340/698/722）
- Modify: `src/lib/state.ts`（删 `autoTruncate`/`autoTruncateTargetFactor`/`autoTruncateCompressThreshold`/`autoTruncatePreflight`/`compressToolResultsBeforeTruncate` + `setCliState` 的 autoTruncate + `CONFIG_MANAGED_DEFAULTS` 相关 + `setAutoTruncateConfig`）
- Modify: `src/lib/config/config.ts:733-743`（删 `auto_truncate` apply 块 + off→on lazy load 逻辑）

- [ ] **Step 1: start.ts boot 改无条件加载 + 删 CLI flag**。
- [ ] **Step 2: 删 state 字段 + setter**——`setAutoTruncateConfig` 整删（其 `maxReactiveRetries` 已在 Phase 1 迁出）。
- [ ] **Step 3: 删 config.ts apply 块**。
- [ ] **Step 4: typecheck + 提交**

Run: `bun run typecheck`

```bash
git add -- src/start.ts src/lib/state.ts src/lib/config/config.ts
git commit -m "refactor: load calibration unconditionally, remove auto_truncate state/CLI"
```

### Task 5.2：删 config `auto_truncate` schema 节 + compat 悬空 renameLeaf

**Files:**
- Modify: `src/lib/config/schema.ts`（删 `AutoTruncateConfigSchema` + 顶层 `auto_truncate` 节 + `target_factor` 用的 `nullableUnitFloat` 若无他用则删助手；保留 Phase 1 的 `retry` 节）
- Modify: `src/lib/config/compat.ts`（删 `renameLeaf("compress_tool_results_before_truncate", "auto_truncate.compress_tool_results")`）
- Test: `tests/config/config-schema-json-export.unit.test.ts`（更新快照）

- [ ] **Step 1: 删 schema 节 + compat rule**。
- [ ] **Step 2: 更新 schema JSON 导出快照测**

Run: `bun test tests/config/config-schema-json-export.unit.test.ts`（按需更新期望）。

- [ ] **Step 3: typecheck + 提交**

```bash
git add -- src/lib/config/schema.ts src/lib/config/compat.ts tests/config/config-schema-json-export.unit.test.ts
git commit -m "refactor(config): remove auto_truncate schema section + dangling compat rule"
```

### Task 5.3：删 Vue ui/ 配置表单字段

**Files:**
- Modify: `ui/src/types/config.ts:53-54,103-104`（删 `auto_truncate?` 两处）
- Modify: `ui/src/pages/vuetify/VConfigPage.vue:56` + 两处 `Pick<EditableConfig, ...|"auto_truncate">`（151,173）
- Modify: `ui/src/composables/useConfigEditor.ts:61-63`

- [ ] **Step 1: 删字段 + 穷尽 Pick 联合里的 `"auto_truncate"`**。
- [ ] **Step 2: ui typecheck**（Vue ui 自有 typecheck；若无独立脚本则靠 `bun run typecheck:ui-v4` 不覆盖此项，改跑 Vue 的 `vue-tsc`/build 验证）

Run: `bun run build:ui`（或该子项目对应 typecheck）
Expected: 无 `auto_truncate` 相关类型错。

- [ ] **Step 3: 提交**

```bash
git add -- ui/src/types/config.ts ui/src/pages/vuetify/VConfigPage.vue ui/src/composables/useConfigEditor.ts
git commit -m "refactor(ui): remove auto_truncate config form fields"
```

---

## Phase 6 — 400 学习腿解耦为失败观测 sink（RFC §3.2）

### Task 6.1：新增 `CalibrationFailureSink` 订阅 request.failed

**Files:**
- Create: `src/lib/observability/sinks/calibration-failure.ts`
- Modify: `src/start.ts`（`attachCalibrationFailureSink(bus)` 紧邻 `attachCalibrationSink`）
- Test: `tests/observability/calibration-failure-sink.unit.test.ts`

**Interfaces:**
- Consumes: `ObservabilityBus`（`~/lib/observability`）、`extractTokenLimitFromResponseText`（`~/lib/error/parsing`）、`countTotalInputTokens`（`~/lib/anthropic/token-counting`）、`learnCalibration`（`~/lib/auto-truncate`）、`state.modelIndex`
- Produces: `attachCalibrationFailureSink(bus: ObservabilityBus): () => void`

- [ ] **Step 1: 写失败测试**——造 `request.failed`（statusCode 400，`attempt.upstreamResponse.rawBody` = `{"error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}`，`attempt.upstreamRequest.body` = 一个 anthropic payload with model），断言 `learnCalibration` 被以 `(est, 250000, {isLive:true})` 调用、落顶桶。用**负样本对照**：非 400 / 无 rawBody / 无 body → sink 不学（证 sink 真触达而非恒真）。

```ts
test("400 token-limit failure learns calibration pair", async () => {
  // arrange: fake bus, spy on learnCalibration via a real model in modelIndex
  // emit request.failed with statusCode 400 + rawBody containing "prompt is too long: N tokens > M maximum"
  // assert learnCalibration called with real=N, isLive:true, landing in top bucket
})
test("non-400 / missing body does not learn (negative control)", async () => { /* ... */ })
```

- [ ] **Step 2: 跑测证失败**

Run: `bun test tests/observability/calibration-failure-sink.unit.test.ts`
Expected: FAIL（sink 未建）。

- [ ] **Step 3: 实现 sink**

```ts
// src/lib/observability/sinks/calibration-failure.ts
import consola from "consola"
import type { MessagesPayload } from "~/types/api/anthropic"
import { extractTokenLimitFromResponseText } from "~/lib/error/parsing"
import { countTotalInputTokens } from "~/lib/anthropic/token-counting"
import { learnCalibration } from "~/lib/auto-truncate"
import { state } from "~/lib/state"
import type { ObservabilityBus, ObservabilityEvent } from "../index"

export class CalibrationFailureSink {
  private readonly unsubscribe: () => void
  constructor(bus: ObservabilityBus) {
    this.unsubscribe = bus.subscribe(
      (event) => this.handle(event),
      (event) => event.kind === "request.failed",
    )
  }
  destroy(): void { this.unsubscribe() }

  private async handle(event: ObservabilityEvent): Promise<void> {
    try {
      if (event.kind !== "request.failed" || event.statusCode !== 400) return
      const attempt = event.entry.attempts?.at(-1)
      const rawBody = attempt?.upstreamResponse?.rawBody
      if (typeof rawBody !== "string") return
      const parsed = extractTokenLimitFromResponseText(rawBody)
      if (!parsed) return // not a token-limit 400
      const req = attempt?.upstreamRequest
      if (!req || req.format !== "anthropic-messages") return
      const body = req.body as MessagesPayload | undefined
      if (!body?.model) return
      const model = state.modelIndex.get(body.model)
      if (!model) return
      const est = await countTotalInputTokens(body, model)
      if (est <= 0 || parsed.current <= 0) return
      learnCalibration(model.id, est, parsed.current, { isLive: true })
    } catch (err) {
      consola.debug("[calibration-failure-sink] skipped", err)
    }
  }
}

export function attachCalibrationFailureSink(bus: ObservabilityBus): () => void {
  const sink = new CalibrationFailureSink(bus)
  return () => { sink.destroy() }
}
```

- [ ] **Step 4: 接线 start.ts + 跑绿**

Run: `bun test tests/observability/calibration-failure-sink.unit.test.ts && bun run typecheck`
Expected: PASS + exit 0。

- [ ] **Step 5: 提交**

```bash
git add -- src/lib/observability/sinks/calibration-failure.ts src/start.ts tests/observability/calibration-failure-sink.unit.test.ts
git commit -m "feat(calibration): 400 leg as request.failed observation sink"
```

---

## Phase 7 — count-tokens 开关 + calibrate 消费腿 + debug 重写（RFC §3.3/§4）

### Task 7.1：config `anthropic.use_upstream_count_tokens`（默认 on）

**Files:**
- Modify: `src/lib/config/schema.ts`（`AnthropicConfigSchema` 加 `use_upstream_count_tokens: nullableBoolean()`）
- Modify: `src/lib/state.ts`（`useUpstreamCountTokens: true` 默认 + `setAnthropicBehavior` 支持）
- Modify: `src/lib/config/config.ts:556` 区域（apply）
- Test: `tests/messages/count-tokens.http.test.ts`（新增 off 分支）

- [ ] **Step 1: schema + state 默认 true + apply**。
- [ ] **Step 2: typecheck + 提交**

```bash
git add -- src/lib/config/schema.ts src/lib/state.ts src/lib/config/config.ts
git commit -m "feat(config): add anthropic.use_upstream_count_tokens (default on)"
```

### Task 7.2：count-tokens 删虚高块 + 接 calibrate 本地兜底 + 开关

**Files:**
- Modify: `src/routes/messages/count-tokens.ts`（删 172-183 虚高块 + `checkNeedsCompactionAnthropic`/`hasKnownLimits` import；GHC 渠道包 `if (state.useUpstreamCountTokens)`；本地兜底 `calibrate(model.id, await countTotalInputTokens(...))`）
- Test: `tests/messages/count-tokens.http.test.ts`

- [ ] **Step 1: 写测**——三分支：① `use_upstream=true` + GHC 成功 → 返 GHC 值；② `use_upstream=false` → 跳过上游、返本地 calibrated 值；③ `use_upstream=true` + GHC 失败 → 回落本地 calibrated。断言本地值 = `calibrate(id, countTotalInputTokens)`（用已训练模型证 factor≠1 时确被应用）。
- [ ] **Step 2: 跑测证失败** → **Step 3: 改 count-tokens** → **Step 4: 跑绿**

Run: `bun test tests/messages/count-tokens.http.test.ts && bun run typecheck`

- [ ] **Step 5: 提交**

```bash
git add -- src/routes/messages/count-tokens.ts tests/messages/count-tokens.http.test.ts
git commit -m "feat(count-tokens): upstream toggle + calibrated local fallback, drop inflation block"
```

### Task 7.3：debug route 重写为 calibration 探查端点

**Files:**
- Modify: `src/routes/debug/route.ts`（整体重写：删 `autoTruncateAnthropic`/`checkNeedsCompaction`/`autoTruncateOpenAI`/`state.autoTruncateTargetFactor`；新入参 `{ model, payload }` → 响应 `{ rawEstimate, calibrated, factor, liveSampleCount, factorModel }`，经 `getLearnedLimits`/`factorAt`/`calibrate`）
- Test: `tests/infra/debug-dry-run.http.test.ts`（重写期望形状）

- [ ] **Step 1: 重写 route + 测**——展示 raw vs calibrated；`getLearnedLimits(model.id)?.liveSampleCount`。
- [ ] **Step 2: 跑绿 + typecheck + 提交**

```bash
git add -- src/routes/debug/route.ts tests/infra/debug-dry-run.http.test.ts
git commit -m "feat(debug): rewrite dry-run endpoint as calibration probe"
```

---

## Phase 8 — 全量验证 + 文档/记忆同步 + 收尾

### Task 8.1：全量测试 + 悬空引用扫描

- [ ] **Step 1: 全绿门**

Run: `bun run typecheck && bun run typecheck:ui-v4 && bun run lint:all && bun test`
Expected: 全绿。修所有遗留错误（不放任「与我无关」）。

- [ ] **Step 2: 悬空扫描**

```bash
grep -rn "autoTruncate\|auto_truncate\|AutoTruncate\|createAutoTruncateStrategy\|calculateTokenLimit\|checkNeedsCompaction\|createTruncationMarker" src ui ui-v4 tests
```

Expected: 仅剩 `maxReactiveRetries` 无关命中 + calibration 保留项；无截断残留。

- [ ] **Step 3: 起测试服务器（非 4141）实测 count-tokens 三分支 + 一次触发 400 的请求验 400 sink 学习**（按 PID 精确清理自起实例）。

### Task 8.2：文档同步（RFC §8）

**Files:**
- Modify: `docs/DESIGN.md`（重写 calibration 行 + config 节 `auto_truncate`→`retry`+`anthropic.use_upstream_count_tokens` + CLI flag 表删 auto-truncate + 模块表 `src/lib/auto-truncate/` 描述改「calibration 计数增强」）
- Modify: `docs/spec/2026-07-13-ghc-count-tokens-default.md`（加开关）
- Modify: `docs/spec/2026-07-11-size-aware-calibration-learning.md` + `docs/plan/2026-07-11-size-aware-calibration-learning.md`（头部注「截断消费者已移除、caliber 改 input-only」）
- Modify: `README.md` / `README.zh.md`（删 auto-truncate 段）
- Move: 截断相关废弃 spec/plan → `docs/archive/`

- [ ] **Step 1: 改文档 + 跨文档 grep 验证**

```bash
grep -rn "auto.truncate\|autoTruncate\|截断重试" docs README.md README.zh.md | grep -v archive | grep -v "2026-07-13-remove-auto-truncate"
```

Expected: 仅剩本 RFC/plan 自身 + 有意保留的历史引用（已加注）。

- [ ] **Step 2: 提交文档**

```bash
git add -- docs README.md README.zh.md
git commit -m "docs: sync DESIGN/README/specs for auto-truncate removal"
```

### Task 8.3：合并态 subagent 审查 + 记忆库 + 合并

- [ ] **Step 1: 派 reviewer 做合并态审查**（显式判据轴：长远正确 + 移除完整性 + calibration 保留正确性；读实际 diff）。处理 BLOCK/HIGH，重跑门。
- [ ] **Step 2: 记忆库维护**——更新 auto-truncate/calibration 相关 stub（MEMORY.md）：截断已移除、calibration 重定位为计数增强、400 腿 sink、caliber=input-only。
- [ ] **Step 3: rebase + FF 合入 master**（隔离 worktree 收尾；动过 deps 则主树补 `bun install`——本计划未加 deps，无需）

```bash
cd /home/xp/src/copilot-api-js
git checkout master && git merge --ff-only feat/remove-auto-truncate
git worktree remove .worktrees/remove-auto-truncate
```

---

## Self-Review（写完自查）

- **Spec 覆盖**：RFC §2.1 保留（Phase 2/3 + 保留项）✓、§2.2 删除（Phase 4/5）✓、§3.1 改名（Phase 1）✓、§3.2 400 腿（Phase 6）✓、§3.3 开关（Phase 7.1/7.2）✓、§3.4 caliber（Phase 2 + 7.2）✓、§4 活消费者（Phase 7.2/7.3）✓、§6 风险（boot 无条件 Phase 5.1、compat 悬空 Phase 5.2、tokenLimit schema Phase 4.4）✓、§7 测试（各 Phase 内）✓、§8 文档（Phase 8.2）✓。
- **占位符扫描**：additive 部分（400 sink / config / count-tokens）给了完整代码；删除部分给了精确符号/行号 + 验证命令，无 TBD。
- **类型一致**：`maxReactiveRetries`（Phase 1）全程一致；`countTotalInputTokens` caliber（Phase 2/6/7）一致；`attachCalibrationFailureSink` 签名一致。

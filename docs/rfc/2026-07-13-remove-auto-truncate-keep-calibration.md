# RFC：移除 auto-truncate 截断本体，保留 calibration 作诚实计数

- 状态：草案（待 subagent 对抗评审）
- 日期：2026-07-13
- 归属路线图：`docs/DESIGN.md`「活的架构现状」auto-truncate calibration 行（本 RFC 落地后重写该行）
- 相关：`docs/spec/2026-07-13-ghc-count-tokens-default.md`（count_tokens 默认渠道，本 RFC 新增其开关）、`docs/spec/2026-07-11-size-aware-calibration-learning.md`（calibration 因子模型，保留但重定位）

## 1. 目标与动机（What / Why）

删除「auto-truncate 截断本体」——即在反应式重试时**截断 / 压缩请求 payload** 的整套机制——原因：

1. **破坏 KV / prompt cache。** 截断改写请求 payload，使上游 GHC 的 prompt cache 全 miss，长会话成本与延迟反而变差。
2. **实际效果不佳。** 二分查找截断点、压缩 tool_result、注入截断上下文等启发式对话质量不稳定，收益低于其复杂度。
3. **上游已自理。** Claude Code 现在自己会处理上下文超限（auto-compact），代理层不再需要越俎代庖。

**同时保留** `src/lib/auto-truncate/` 里的 **calibration 因子模型**，并**重定位**其职责：从「为截断预判 token limit」改为「提升本地 token 计数的准确度」。calibration 本身不改写请求、不破坏 cache，是纯粹的观测 / 计数增强，值得留下。

**非目标**：不改变 GHC 上游行为；不动 L2 缓冲重试（`protect_streaming_generation`，与截断正交）；不动通用翻译矩阵、negotiation 学习等其它反应式策略——仅移除截断这一条策略腿与其预检查、配置、UI。

## 2. 保留 / 删除边界

### 2.1 保留（calibration + 诚实 token 计数）

| 单元 | 说明 |
|---|---|
| `src/lib/auto-truncate/engine.ts` 的 calibration 部分 | `FactorModel` / `FactorBucket` / `ModelLimits`（去 `tokenLimit` 字段）、桶原语、`factorAt` / `calibrate` / `learnCalibration`、seed（`DEFAULT_FACTOR_SEED` / `seedFactorModel` / `seedTopBucketOnly`）、`ensureModelLimits`、`applyBackfillBuckets`、持久化（`persistLimits` / `loadPersistedLimits` / `schedulePersist` / `setLearnedLimitsPathForTests`）、`getLearnedLimits`（debug 探查读 `liveSampleCount` / `factorModel`，见 §4）。**`hasKnownLimits` 移到删除侧**——其唯一消费者是被删的 count-tokens 虚高块，移除后零消费者 |
| `src/lib/observability/sinks/calibration.ts` | 成功腿 `CalibrationSink`（订阅 `request.completed`，每请求学习） |
| `src/lib/history/sqlite/calibration-backfill.ts` | 冷启动可恢复 backfill |
| token 计数子模块 | `anthropic/auto-truncate/token-counting.ts`（`countTotalTokens` / `countTotalInputTokens` 等）——**迁出** `auto-truncate/` 命名空间到 `src/lib/anthropic/token-counting.ts`，同步全部 import |
| `tool-utils.ts` 的 `ensureAnthropicStartsWithUser` | 被 `sanitize/system-messages.ts` 消费（非截断），随 token-counting 一并保留 / 迁出 |

### 2.2 删除（截断本体）

| 单元 | 说明 |
|---|---|
| 截断算法整文件 | `anthropic/auto-truncate/truncation.ts`、`openai/auto-truncate/truncation.ts`、`openai/auto-truncate/token-counting.ts`（openai 计数只服务 openai 截断） |
| 截断入口函数 | `anthropic/auto-truncate.ts` 的 `autoTruncateAnthropic` / `checkNeedsCompactionAnthropic` / `createTruncationResponseMarkerAnthropic`；`openai/auto-truncate.ts` 全部 |
| 反应式截断策略 | `request/strategies/auto-truncate.ts`、`request/truncation.ts`（marker） |
| engine.ts 截断专属 | `AutoTruncateConfig` / `DEFAULT_AUTO_TRUNCATE_CONFIG`、`MAX_AUTO_TRUNCATE_RETRIES` / `AUTO_TRUNCATE_RETRY_FACTOR`、`ModelLimits.tokenLimit` 字段、`calculateTokenLimit`、`computeSafetyMargin`、`hasKnownLimits`、`compressToolResultContent` / `compressCompactedReadResult`、`onTokenLimitExceeded` / `tryParseAndLearnLimit` / `LimitErrorInfo`（400 腿改由 sink 承接，见 §3.2） |
| codec 预检查 | `codec/anthropic/codec.ts` 的 `preSend` 预截断（约 581-620） |
| 策略装配 | `codec/anthropic/strategies.ts` 与 `codec/openai-cc/strategies.ts` 里 `createAutoTruncateStrategy` 相关行 |
| handler 截断产物接线 | `routes/messages/handler-v4.ts`（`truncateResult` 全套 + `createTruncationMarker` import，约 18 处引用）、`routes/chat-completions/handler-v4.ts`（`truncateResult` 全套 + `OpenAIAutoTruncateResult` import + `recordFeature("truncated")`，约 15 处）、`routes/messages/retry-meta-feature.ts:24` 的 `if (hasTruncateResult) return { feature: "truncated" }` 分支 |
| FeatureKind `"truncated"` | `observability/events.ts:128` 的 `FeatureKind` 联合成员 + 唯一渲染点 `lib/tui/terminal-ui.ts:1223` 的 `case "truncated":`。**⚠️ 删除陷阱**：`"truncated"` 字面量被两个无关概念共用——① 此处的 FeatureKind（删）；② `TerminalOutcome { kind: "truncated" }`（流未收 message_stop 的分类，遍布 `reverse-terminal.ts:34/44`、`driver.ts:726`、各流式 handler，**绝不能删**）。执行者不得「grep truncated 一把梭」 |
| request 层导出 | `request/index.ts:18-24` 的 `TruncateOptions` / `TruncateResult` / `createAutoTruncateStrategy` / `TruncateResultInfo` / `createTruncationMarker` 导出 |
| boot 加载门控 | `start.ts:499` 的 `if (state.autoTruncate) { await loadPersistedLimits() }` → 改为**无条件** `await loadPersistedLimits()`（该调用同时 materialize `DEFAULT_FACTOR_SEED` + 读磁盘学习值，是 §4 本地 calibrated 兜底的因子来源，删门控但不补无条件调用会令冷启动 `calibrate` 静默退化为恒等）；`config.ts` 的 off→on lazy `loadPersistedLimits` 热重载逻辑随 `auto_truncate` 节删除而消失（正好） |
| state | `autoTruncate` / `autoTruncateTargetFactor` / `autoTruncateCompressThreshold` / `autoTruncatePreflight` / `compressToolResultsBeforeTruncate`（`autoTruncateMaxRetries` 改名保留，见 §3.1） |
| config | `auto_truncate` 整节（`enabled` / `target_factor` / `compress_threshold` / `compress_tool_results` / `preflight`），schema.ts + config.ts + compat.ts |
| CLI | `--auto-truncate` / `--no-auto-truncate`（start.ts） |
| routes/debug | 截断测试端点改造为 calibration 探查（见 §4） |
| routes/messages/count-tokens | 删「虚高诱导截断」块（约 172-183） |
| UI | **仅 Vue `ui/`**（ui-v4 无任何 auto_truncate 引用，已核实）：`ui/src/types/config.ts:53-54,103-104`、`ui/src/pages/vuetify/VConfigPage.vue:56` + 两处 `Pick<EditableConfig, ...|"auto_truncate">` 穷尽联合（151/173，删节后会 TS 报错须一并删）、`ui/src/composables/useConfigEditor.ts:61-63` |
| docs | README / README.zh 的 auto-truncate 段；相关 spec 归档标注 |
| tests | ~10 个截断测试文件（`tests/pipeline/auto-truncate*`、`truncation-marker`、`src/lib/auto-truncate/engine.consumers.test.ts` 的截断部分等）——calibration 测试保留 |

## 3. 三个承重决策

### 3.1 全面改名共享重试预算

`state.autoTruncateMaxRetries` 名为 auto-truncate，实为**全部 17 个反应式策略共享的重试上限**（network / server-error / token-refresh / effort-learning / tool-field / body-field / cache-control / legacy-thinking / adaptive-thinking / poisoned-thinking / unsupported-beta / server-tool / structured-outputs / system-reject / web-search / deferred-tool / auto-truncate），经 `buildAnthropicStrategies` 的 `adapt` 闭包传给每个策略的 `maxRetries`。删除截断后此预算**必须存活**，否则砍掉所有反应式重试的预算。

改名（连带扫清所有把此预算称作「auto-truncate」的注释 / 文档）：

- state：`autoTruncateMaxRetries` → `maxReactiveRetries`
- config：`auto_truncate.max_retries` → 新 `retry.max_reactive_retries`（默认 5）
- 兼容层：旧键 `auto_truncate.max_retries` 读时映射到新键 + 弃用警告并继续（遵项目「配置留兼容层」纪律，[[feedback-config-philosophy-separate-compat-and-warn-continue]]）
- 删 engine.ts 的 `MAX_AUTO_TRUNCATE_RETRIES` / `AUTO_TRUNCATE_RETRY_FACTOR` 常量

### 3.2 400 学习腿保留，解耦重构为失败观测 sink

现状：400 腿 `tryParseAndLearnLimit` → `onTokenLimitExceeded` 内嵌在**被删的**反应式截断策略里，既学 `tokenLimit`（截断用，删）又学 calibration pair（计数用，留）。

重构：把 calibration pair 的学习**解耦**成一个失败腿 sink，与成功腿 `CalibrationSink` 对称并列——

- 订阅 `request.failed`（`statusCode === 400`）。已核实：删截断策略后 `prompt is too long` 400 无任何其它策略认领（逐一核对 effort / tool-field / body-field / cache-control / legacy-thinking / adaptive / poisoned / unsupported-beta / server-tool / structured-outputs / system-reject / web-search / deferred-tool 的 matcher 均 disjoint），确定落到 driver 的 `request.failed`
- 文本源**只用** `attempt.upstreamResponse.rawBody`（`responseText` 投影，逐字上游 body）——**不**用 `event.error`（= 归一化后的 `failureReason`，不保证含逐字 `prompt is too long: N tokens > M maximum`，正则会 miss）
- 复用已有 battle-tested 的 `extractTokenLimitFromResponseText(rawBody)`（`src/lib/error/parsing.ts:72`，内部先 `JSON.parse` 再 `parseTokenLimitError`，已被 error/classify.ts、error/forward.ts 广泛使用）——**不**在 sink 里手搓 JSON 解析
- `current` = 上游实测真值，是**高 token 桶的宝贵 ground truth**（成功请求都在 limit 之下、成功腿够不到顶桶）
- 重算本地估算 → `learnCalibration(model.id, est, current, { isLive: true })`（est caliber 见 §3.4）
- never-throw fire-and-forget，与成功腿同构；`body` 从 `attempt.upstreamRequest.body` 取、`model` 从 `state.modelIndex.get(body.model)` 取，**任一取不到则跳过**（守卫，绝不抛）

比现在「策略内解析」的耦合更干净，且截断删除后 400 腿不再依赖任何被删机器。

### 3.4 caliber 统一：两条训练腿 + count-tokens 消费腿一律用 `countTotalInputTokens`

因子模型的 `bucketIndexFor` / `factorAt` 假设入参 est 与训练 est 同 caliber。现状 landed 成功腿（`calibration.ts:78`）用 `countTotalTokens`（**含** prior-turn thinking 块），但配对的 real = `usage.input_tokens + cache legs`，而上游 `input_tokens` 按 Anthropic 规范**排除** prior-turn thinking——est 与 real caliber 已有潜在错配（landed 遗留）。§4 新消费腿若用 `countTotalInputTokens`（排除 thinking）会引入第三种 caliber。

**决定：统一为 `countTotalInputTokens`**——成功腿、400 腿、count-tokens 消费腿全部用它。理由：它排除 thinking-as-input，恰与上游 `usage.input_tokens` 的口径一致，配对更准，且顺带修掉成功腿的潜在 caliber 错配。这是对 landed calibration 的一处有意的 caliber 收敛（属本次 calibration 正确性范围）。变更后 backfill（`calibration-backfill.ts:247`）也须同步改用 `countTotalInputTokens`，保持三方一致。

### 3.3 count_tokens GHC 上游开关

新增 config `anthropic.use_upstream_count_tokens`（挂现有 `anthropic` 节，默认 `true`）：

- `true`（默认）：现有三层不变——GHC 上游精确计数 → 本地估算兜底
- `false`：跳过 `countTokensViaGhc` 上游往返，直接走本地估算

同步更新 `docs/spec/2026-07-13-ghc-count-tokens-default.md`（新增该开关；默认行为不变）。

## 4. 关键补强：calibration 必须有活消费者

移除截断后，`calibrate()` 的**原有消费者全部消失**（`checkNeedsCompactionAnthropic` 与 openai 截断均删）。若不接新消费者，calibration 将沦为「有学习、无读者」的死代码，违背项目「不留死代码」纪律。

把 `calibrate()` 接进本地计数路径，作为「诚实计数」的落地：

- **count-tokens 本地兜底**：`calibrate(model.id, await countTotalInputTokens(payload, model))`（caliber 见 §3.4）——用 learned 因子把本地 tiktoken 估算逼近上游真实计数。GHC 上游可用时仍以其精确值优先；`use_upstream_count_tokens=false` 或上游失败时，calibrated 本地值是最准的可得计数。
- **routes/debug/route.ts**：现文件几乎全绕截断（`autoTruncateAnthropic` / `checkNeedsCompaction` / `autoTruncateOpenAI` / `state.autoTruncateTargetFactor`），**整体重写**为「calibration 探查端点」——入参 schema 与响应形状全换：展示 raw estimate vs `calibrate()` 后的值、`getLearnedLimits(modelId)` 读出的 `liveSampleCount` / `factorModel`、`factorAt` 曲线。这给 `liveSampleCount` 与 `getLearnedLimits` 一个真读者（否则删 `computeSafetyMargin` 后 `liveSampleCount` 无人读）。

由此 calibration 全套（成功腿 + 400 腿 + backfill + seed + 持久化）都服务于一个活目标：**GHC 上游不可用 / 被关时，本地 token 计数的准确度**。

> **命名旁注**：`codec.getTruncateBaseline()`（三 codec）名带 Truncate，但 `deps.originalPayload` 经 `adaptLegacyStrategy` 喂给**全部**适配策略作 retry 基线（非截断专用），故**保留**；建议顺带更名 `getRetryBaseline` 以免后续读者误以为它随截断死了而误删。同理 `liveSampleCount` / backfill 的 `isLive` 保全逻辑删 `computeSafetyMargin` 后仅剩 debug 一个读者，保留理由降级为「纯诊断可见性」。

## 5. 落地纪律

- 走 RFC-first。这是 ≥1000 行结构性删除，但**不强求 commit-invariants**（用户明确放宽）：允许中间态编译不过 / 半坏，best-effort 分阶段提交即可（[[git-commit-pathspec-commits-worktree-not-index]] 显式 pathspec、每语义单元一提交仍照做）。
- **golden-fixture 预捕获**：改动前先锁 calibration `factorAt` / `calibrate` 与 count-tokens 三通道（GHC / 本地 raw / 本地 calibrated）的行为快照，证保留部分等价、无回归。
- token-counting 子模块迁出 `auto-truncate/` 后，`tsc --noEmit`（`typecheck`）+ `typecheck:ui-v4` + 全量 `bun test` 三绿再收尾。
- 隔离 worktree（`.worktrees/`）+ 独立分支，避与并发会话冲突。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| token-counting import 迁移遗漏 | 迁出后全仓 grep 旧路径 `auto-truncate/token-counting`，typecheck 兜底 |
| config `auto_truncate` 节删除令旧配置文件报错 | 兼容层：`auto_truncate.max_retries` 经 `renameLeaf` 映射到 `retry.max_reactive_retries` + 弃用警告；其余全删的 `auto_truncate.*` 键（`enabled` / `target_factor` / `compress_threshold` / `preflight`）走 config 现有的**通用未知键处理**——`.strict()` + `cleanInvalidPaths` 发通用 `Unknown key(s)…` 警告后 strip、不 fail（非定向弃用文案；若要定向提示须为各键加 `removeKey` 迁移，本 RFC 不做）。**另须删** `compat.ts` 里 `renameLeaf("compress_tool_results_before_truncate", "auto_truncate.compress_tool_results")`——其目标正是被删节，留着会把旧键映射到失效路径致值被 `cleanInvalidPaths` 静默丢弃 |
| 删 `computeSafetyMargin` 致 `liveSampleCount` 无读者 | §4 debug 探查端点经 `getLearnedLimits` 消费它 |
| 删 `ModelLimits.tokenLimit` 改持久化 schema | 保持 v2 版本号、读时忽略旧 `tokenLimit`（删 `loadPersistedLimits` 里 v2 的 `...(lim.tokenLimit !== undefined && …)` 与 v1 迁移的 `...(lim.tokenLimit > 0 && …)` 两行）；`factorModel` / `boundsVersion` 形状不变，旧 v2 文件读时自洽——**reviewer 背书此判断正确**。learned-limits 是可重学数据、非配置，无需兼容层 |
| 400 腿 sink 拿不到本地估算 model/body | 与成功腿同法从 `attempt.upstreamRequest.body` + `state.modelIndex.get(body.model)` 取，任一取不到则跳过（never-throw） |

## 7. 测试策略

- **保留并适配** calibration 单测（`engine.factor-model.test.ts` / `engine.persist.test.ts`、`calibration.test.ts`、`calibration-backfill.test.ts`）——删其中依赖 `tokenLimit` / `calculateTokenLimit` / `computeSafetyMargin` 的用例。
- **新增** 400 失败腿 sink 单测：造 `request.failed` + 400 token-limit rawBody → 断言 `learnCalibration` 落对桶（用负样本对照证 sink 真触达，[[feedback-pass-null-clean-not-self-validating]]）。
- **新增** count-tokens 三分支测：`use_upstream_count_tokens` on/off × GHC 成功/失败 × 本地 calibrated 值。
- **新增** caliber 一致性测：成功腿 / 400 腿 / count-tokens 消费腿三方 est 均经 `countTotalInputTokens`，落同一桶（§3.4）。
- **删除** 截断行为测试（`auto-truncate*` / `truncation-marker`）。
- **迁移** 共享重试预算测：改用 `maxReactiveRetries` / `retry.max_reactive_retries`；config 兼容层测旧键映射 + 警告。

## 8. 文档同步清单（收尾）

- `docs/DESIGN.md`：重写 auto-truncate calibration 行（改称 calibration 计数增强）、config 节删 `auto_truncate` / 加 `retry` + `anthropic.use_upstream_count_tokens`、模块表 `src/lib/auto-truncate/` 描述、CLI flag 表删 auto-truncate 行
- `docs/API.md` / `docs/CONFIG.md`（若有）：config 键增删
- `docs/spec/2026-07-13-ghc-count-tokens-default.md`：新增开关
- `docs/spec/2026-07-11-size-aware-calibration-learning.md` + `docs/plan/2026-07-11-size-aware-calibration-learning.md`：头部标注「截断消费者已移除，calibration 重定位为本地计数增强」
- README / README.zh：删 auto-truncate 功能段
- 归档：截断相关废弃 spec / plan 移 `docs/archive/`
- 记忆库：更新 auto-truncate / calibration 相关 stub

## 9. 评审与 Open Questions

**Open Questions**：无阻塞项。三个承重决策已由用户裁定（改名 / 保留 400 腿 / `anthropic.use_upstream_count_tokens` 默认 on）。

**subagent 对抗评审（2026-07-13）**：独立 reviewer 核查，0 BLOCK、3 HIGH + 3 MEDIUM，全部经**亲手复核 file:line 属实后采纳**——
- HIGH-1 `start.ts:499` boot 加载门控 → §2.2 补无条件 `loadPersistedLimits`
- HIGH-2 handler `truncateResult` 全套 + `FeatureKind "truncated"` + `"truncated"` 字面量重载陷阱 → §2.2 补 handler/feature/exports 行 + 显式保留 `TerminalOutcome.kind`
- HIGH-3 `hasKnownLimits` 删后零消费者 → 从保留侧移到删除侧
- MEDIUM caliber 错配 → §3.4 统一 `countTotalInputTokens`（顺带修 landed 遗留）
- MEDIUM 取文本手法 → §3.2 改用 `extractTokenLimitFromResponseText(rawBody)`、只用 rawBody 不用 event.error
- MEDIUM compat 悬空 renameLeaf → §6 补删除
- 建议（UI 仅 Vue、getRetryBaseline 命名、debug 整体重写）均已并入
- reviewer 背书 Q5 持久化判断、Q3 400-腿架构方向正确


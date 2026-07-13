# RECONCILE：CellAssembly 出站重构 ⟂ master 的「移除 auto-truncate」项目

> **状态**：🔴 合并阻塞（根本性架构不兼容）。本会话（2026-07-13）把 CellAssembly 出站迁移做到干净里程碑（分支 `feat/inbound-outbound-split` @ `9388ddb1`，全 12 出站 cell 走单一 `resolveCellAssembly`、字节等价、reviewed、base 5），**但发现 master 已 landed 并发会话的「移除 auto-truncate 保留 calibration」项目**，与本重构的**策略半**根本不兼容，机械合并弥合不了。本文是下一会话 reconcile 的入口。

## 1. 不兼容根因（实证）

分支从旧 master `e9f6ce8a` 切出；现 master tip `cf24946a` 已前进 **152 个 peer commit**，其中 landed 了「remove-auto-truncate-keep-calibration」项目。实测确证 master 侧：
- `src/lib/request/strategies/auto-truncate.ts` **已删**（`git show master:...auto-truncate.ts` = does not exist）。
- `state.autoTruncateMaxRetries` → 全局重命名 **`state.maxReactiveRetries`**（config `retry.max_reactive_retries`，`setReactiveRetryConfig`）。
- `anthropicPreSend` / `autoTruncatePreflight` **全仓归零**（`git grep master` 空）；anthropic codec 无 preSend 方法（但 `FormatCodec.preSend?` 接口 + driver 的 `deps.codec.preSend` 处理**仍在**——只是 anthropic 不再用）。
- calibration 引擎**迁出 auto-truncate 命名空间** → `src/lib/models/calibration`（commit `refactor: move calibration engine out of auto-truncate namespace`）。
- master 的 `buildAnthropicStrategies` 栈 = network→server-error→token-refresh→**effort-learning**→tool-field-reject→body-field-reject→cache-control-subfield-reject→legacy-thinking→adaptive-thinking-reject→unsupported-beta→server-tool-reject→structured-outputs-reject→system-reject→web-search-not-found（**无 auto-truncate**，且 peer 期间**新增了 effort-learning + 多条 rejection 策略**）。
- master 的 `buildOpenAiCcStrategies` = network→server-error→...（无 auto-truncate），deps 用 `maxReactiveRetries` + `label`。

**master 侧权威文档（下会话必读）**：
- `docs/rfc/2026-07-13-remove-auto-truncate-keep-calibration.md`
- `docs/plan/2026-07-13-remove-auto-truncate-keep-calibration.md`
- `docs/memory/project-remove-auto-truncate-keep-calibration.md`

## 2. 本重构的 auto-truncate 耦合面（策略半，需重设计）

CellAssembly 重构的**核心洞察 R1/HIGH-A corner 字面就是「auto-truncate ON vs OFF」**，深度耦合已删特性：
| 耦合点 | 文件 | master landed 后应如何 |
|---|---|---|
| `RetrySemanticsSpec.autoTruncate: boolean` | `cell-assembly.ts` | **删该字段**（无 auto-truncate 概念）；保 `maxRetries`/`label` |
| **R1/HIGH-A corner**（openai-responses direct/fallback OFF vs 同 /responses 腿 cc/gemini/anthropic ON） | `cell-assembly.ts` RETRY_SEMANTICS + `openai-cc-cell.ts`/`openai-responses-cell.ts` retry semantics 函数 | **corner 消解**——核实 post-removal 后同腿各 cell 策略栈是否还有差异（可能只剩 maxRetries：responses 顶层 1 vs 其他 maxReactiveRetries）；R1 corner golden（`cell-assembly.unit.test`）重评/删 |
| `buildCcFamilyLegStrategies` 按 `spec.autoTruncate` 分派 Responses-stack vs CC-stack | `cc-family-strategies.ts` | 改为按 clientFormat/leg 分派（仍需区分 buildOpenAiCcStrategies vs buildOpenAiResponsesStrategies，但判据非 autoTruncate） |
| `buildOpenAiCcStrategies({originalPayload: truncateBaseline, ...})` | `openai-cc-cell.ts`/`cc-family-strategies.ts` | 对齐 master 新 deps（`maxReactiveRetries`；核实 `originalPayload`/truncation baseline 是否还需——无 auto-truncate 可能 moot → `requestState.truncateBaseline` 可能整条删） |
| `anthropicPreSend`（preflight 截断） | `anthropic-leg.ts` + `anthropic-cell.ts`（preSend）+ driver preSend 调用 | **删** anthropic 的 preSend 接线（FormatCodec.preSend 接口保留、但 anthropic-cell 不再供） |
| `state.autoTruncateMaxRetries` | 全部我的新文件（cell-assembly / anthropic-cell / cc-family-strategies / openai-cc-cell / openai-responses-cell） | 全局改 **`state.maxReactiveRetries`** |
| `buildAnthropicStrategies` deps（reverse leg 用） | `anthropic-cell.ts` reverse 分支 | 对齐 master 新 deps + 新增策略（effort-learning 等）——核实 reverse leg 供料是否够 |

## 3. 存活面（结构核，与 auto-truncate 正交）

以下**基本可存活**、只需机械对齐 peer 的字段重命名/新增策略：
- **2D 装配器结构**：`resolveCellAssembly(clientFormat × targetEndpoint)` + 两穷尽 Record（OUTBOUND_LEGS by te / RETRY_SEMANTICS by cf）笛卡尔积覆盖 12 cell。
- **driver cell-keyed hybrid fork** `migratedCell(env)`（requestState 判别器）+ `resolveExchangeStrategies` lazy 解析（+ 已根治的 recordFeature 双记）。
- **wire 半**：所有 `*-leg.ts` 的 translateOut/prepareWire/sampleWireTrack 提取（`anthropic-leg` / `openai-cc-leg` / `openai-responses-leg`）——纯 wire、不碰 auto-truncate（除 anthropicPreSend 一函数）。
- **requestState 载体**（除 truncateBaseline 可能 moot）：betaProbe / resanitize / responsesFallbackScratch / reverseMapperHolder。
- **exchange scratch**（§11.2c fallback）、**observability 保留**（via-responses/via-chat-completions-fallback 移到 leg.translateOut）。
- **C5 低风险删除**（handler 退回入站/写出、strategy-registry 删除、shim 收敛、inspectRequest 切 cell）——独立于 auto-truncate，可存活（但 handler 冲突需按 §4 解）。

## 4. 已知的机械冲突（本会话实测 merge 时遇到，abort 保留）

`git merge master` 撞 10 冲突。已明确的解法（下会话可复用）：
- **4 handler（chat/gemini/messages/responses）**：冲突纯「我删 factory vs peer 字段重命名」→ **take HEAD（我版）** + 全局 `autoTruncateMaxRetries→maxReactiveRetries`。（本会话已试解、未提交，见 abort 前状态）
- **driver.ts**：peer 加 `const vendor = opts.telemetryVendor ?? "unknown"` telemetry 行 + 我把 strategies 换 `resolveExchangeStrategies` → **保 peer vendor 行 + 我的 lazy strategies**。
- **anthropic/codec.ts**：C2a-prep 提取（我 HEAD 侧空、函数在 anthropic-leg.ts）vs peer 删 anthropicPreSend + 保 prepareAnthropicWire/sampleAnthropicRequest inline → **这是 preSend 特性冲突的爆点**，需按 §2 重设计（不能机械 take HEAD，否则重引入 anthropicPreSend）。
- **strategy-registry.unit.test.ts**（DU）：我删了 registry → keep deleted。
- **docs/DESIGN.md + docs/memory/MEMORY.md**：都改了「活的架构现状」/索引 → 手动合并两侧新增行。

## 5. 下会话 reconcile 建议路线

1. 读 master 三份 remove-auto-truncate 文档（§1）+ 本文 + `PROGRESS.md`（含 C5 keep/delete 地图）。
2. **先决策 R1 corner 的命运**（post-removal 后 12 cell 的策略栈实际差异是什么？RetrySemanticsSpec 还需哪些字段？）——这是重设计的锚。可派 architect-advisor 出 reconcile spec。
3. rebase 或 merge master → 按 §2 重设计策略半 + §4 解机械冲突 + 全局字段重命名。
4. 对齐 master 新增策略（effort-learning + rejections）到 reverse leg 供料。
5. 重跑：typecheck 0 + 全量测试（master 的 base 例外集可能已变，须以 rebase 后 master 的绿基线为准，非旧的「base 5」）。R1 corner golden 重评/删。
6. 完成后接**延后的 C5**（codec 出站方法删除 + HIGH-1 hub 提取，keep/delete 地图在 PROGRESS.md）。

## 6. 本会话已交付（分支 @ 9388ddb1，全部已提交、零丢失）

C3-C6 共 18 commit（落在 C0-C2 handoff 之上）：C3（3 CC 形 /chat cell）+ C4（/responses+ws+fallback，全 12 cell + R1 corner golden）+ 独立 reviewer 审 C3+C4（0 BLOCK/1 HIGH recordFeature 双记已根治）+ C5 低风险删除 + C6 doc-sync + 记忆。**核心结构目标已达成**——只是策略半绑在了 master 已移除的 auto-truncate 上。

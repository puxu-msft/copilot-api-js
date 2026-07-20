# Reconcile Report — error-shaping ↔ landed CellAssembly / strategy-registry-removal

- **日期**：2026-07-13
- **分支**：`feat/upstream-error-client-shaping`（34 commit）reconcile 并发落地 master 的 CellAssembly 重构（fork 后 +53 commit）
- **方式**：合并态一次性解冲突（`git merge master`），非逐 commit rebase
- **合并前 feat HEAD**：`18edeff1`；**master**：`3867514a`

## 结论

**status: DONE**。全绿：typecheck、全量回归（tests/anthropic + routes/messages + pipeline + codec + config = 2549 pass / 0 fail / 7 skip）、12 个 error-shaping 特性测试文件（133 pass / 0 fail）、eslint 净、非目标零 feat 改动。

## 冲突面

`git merge master` 只产生 **1 处冲突**：`src/routes/messages/handler-v4.ts`（单个冲突块，原 247–358 行），无 ripple。其余 6 个生产文件（error-shaping.ts / error-shaping-glue.ts / response-rewrite-adapters.ts / schema.ts / state.ts / rewrite-registry.ts）master 零改动，未冲突。`docs/DESIGN.md` auto-merge 成功。

## Phase 5 委派：重接到 CellAssembly seam

**根因**：master 把 Anthropic 策略装配从 handler 的 `buildMessagesDriverStrategies`（**整个删除**）搬到 `src/lib/codec/anthropic/strategies.ts` 的 `buildAnthropicStrategies`，由 `src/lib/codec/anthropic/anthropic-cell.ts` 的 `buildLegStrategies` 调用、经 `resolveCellAssembly(cf, te).buildStrategies` 组合。我原本包裹 `buildMessagesDriverStrategies` MESSAGES 分支的委派因此作废。

**解法**：删掉整个冲突块（取 master 侧 = 函数消失），把委派逻辑落到 master 的新 seam：`anthropic-cell.ts` `buildLegStrategies` 的 **direct 分支**。

```ts
const built = buildAnthropicStrategies({ ... })
if (!state.errorShapingEnabled) return built
return filterDelegatedStrategies(built, state.errorSelfhealDelegate, (strategyName) =>
  env.ctx.recordFeature("error-shaping-selfheal-delegated", { strategyName }),
)
```

- `filterDelegatedStrategies` / `errorSelfhealDelegate` / `recordFeature` 语义与签名**零改动**（`EnvRetryStrategy` = `RetryStrategy` 类型别名，确认无需改类型）。
- `env.ctx` 在 `anthropic-cell.ts` 可达（同文件 `:139`、`directWireDeps` 已用 `env.ctx`），委派回调直接接到该点，**无需回退到 handler 层拿 ctx**。
- 清理 handler-v4.ts 中现已 unused 的 `filterDelegatedStrategies` import（`assembleStrategiesForEndpoint` / `ChatCompletionsPayload` / `RetryStrategy` 等 import 已被 master 一并移走）。

### 关于「:148 vs :156」——任务给的行号方向相反，按代码钉死的意图落点

任务描述把 `anthropic-cell.ts:148` 标为「MESSAGES 直连腿」、`:156` 标为「translate 腿」，但 master 实际代码正相反：`:148` 在 `if (isReverse(env)) { return ... }` 块内（**reverse** `@messages` 腿：cc/responses/gemini 客户端 → Anthropic wire），`:156` 是 **direct** anthropic 客户端腿（读 `rs?.truncateBaseline` / `rs?.resanitize`，1:1 对应我旧 direct 分支的 `codec.getTruncateBaseline()` / `codec.getResanitize()`）。

意图被代码钉死无歧义：**委派只作用于 anthropic 客户端的 direct messages 腿，不碰 reverse/translate 腿**。故落点是 direct 分支（`:156`），**不接** reverse 分支（`:148`）。reverse 腿由 `if (isReverse(env)) return ...` 提前返回，**结构上**永不触达委派代码——比运行时守卫更强，已在代码注释写明。

## Phase 3 终点：复核未位移，G-3 canonical 所有权完好

master 的 handler 重构（C2a → CellAssembly）只动了 **策略装配区**，未碰 **raw-stream pump / 终点区**——故 Phase 3 的 `shapeRawStreamErrorFrame` 4 处调用点（当前 handler-v4.ts `:1163` / `:1277` / `:1424` / `:1454`）随 master 侧**干净合并、零冲突**，语义完整：

- `:512` G-3 主 direct 腿 canonical 委派（disabled = legacy frame）注释保留；
- `:1163` raw-stream 主 error 终点；`:1277` truncation（no message_stop）终点；
- `:1418`–`:1424` / `:1449`–`:1454` translate 腿 H3 error + truncation 终点（G-3 FIX-2，byte-identical 于旧手搓 JSON）。

独立 oracle 佐证：`translate-leg-error-shaping.it.test.ts` / `postcommit-truncation-shaping.it.test.ts` / `postcommit-error-shaping.{it,unit}` 端到端跑这些终点，全绿。**无位移、无重接需求**。

## Phase 5 测试重接

`tests/routes/messages/handler-v4-selfheal-delegation.it.test.ts` 原驱动已删的 `buildMessagesDriverStrategies(env, {codec, betaProbe})`，重接到 master 新 seam `resolveCellAssembly("anthropic", ENDPOINT.MESSAGES).buildStrategies(env)`：

- `codec.parse(raw)` 仍一步填 `env.requestState`（betaProbe/truncateBaseline/resanitize，见 `codec.ts:241-244`）+ 真 `env.ctx`（`withCapturingManager`），故 4 个正向断言（默认不影响 / delegate 强制 canHandle=false + recordFeature 恰一次 / disabled 回退全栈 / 未知 key 静默忽略）机制不变。
- 约束 3（forward translate 腿不受影响）：原测的 CC/Responses 腿在新结构里是**另一条腿**（chatCompletionsLeg/responsesLeg 经 cc-family-strategies），重接到 `resolveCellAssembly("anthropic", CHAT_COMPLETIONS/RESPONSES).buildStrategies`；仍以「无 `.ctx` 的 fake env 不抛 = forward 腿未碰 recordFeature」证明委派不泄漏。

## 非目标零改动确认

`git diff master -- src/lib/codec/openai-cc src/lib/codec/openai-responses src/lib/openai/responses-stream-accumulator.ts` = **空**（工作树与 master 逐字一致，feat 未新引入任何对这些文件的改动）。

## 改动文件清单（reconcile 本身）

- `src/routes/messages/handler-v4.ts` —— 删冲突块（`buildMessagesDriverStrategies` 整函数随 master 消失）+ 清理 unused import。
- `src/lib/codec/anthropic/anthropic-cell.ts` —— direct 分支包裹 `filterDelegatedStrategies` + import。
- `tests/routes/messages/handler-v4-selfheal-delegation.it.test.ts` —— 重接到 `resolveCellAssembly().buildStrategies` seam。

## Concerns

- **无阻塞项**。委派落点、Phase 3 终点均由代码 + 独立 oracle 钉死，无语义歧义。
- merge commit 未 FF master（按契约，ref 移动交主会话）。

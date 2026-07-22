# Kickoff: DI-5 followup — journal recovery 修复 + drain retry 总耗时上限

> 复制本文件全文到新会话启动。自包含——开场读完本文即可开工。
> 交接自一个上下文已满的长会话（DI-5 transient-retry 已实施 `5c164f0e`，本文是其对抗审查暴露的两个 followup）。

## 背景（30 秒）

DI-5 已把 V3 history drain 的「transient 持久化失败无条件丢弃 entry」修成有界 retry（commit `5c164f0e`）。其**论证前提**是：「V3 写路径 journal-first（`commitPreparedOperation` 先写 self-contained v3_journal 行、tx 内写 operations 并 DELETE journal；`recoverV3Journal` 启动重放）已覆盖 tx 失败/崩溃，故只需补 transient retry」。GPT 对抗审查 + 主线亲核发现：**这个前提当前不成立**——journal recovery 本身坏了。两个 followup 由此而来，followup-1 是 followup-2 的先决（也是 DI-5 论证成立的先决）。

台账语境：[docs/v4/06-inherited-issues.md](../v4/06-inherited-issues.md) 末节「DI-5 实施落地 + 对抗审查」。

## Followup-1（HIGH，先决）— recoverV3Journal 漏过 withDispatchAlias

**症状**：`recoverV3Journal` 恒返回 0，恢复不了任何 uncommitted journal 行。两个既有测试当前红：
- `tests/history/v3/store.it.test.ts` 「recovers a self-contained uncommitted journal after the operation transaction fails」（断言 `recoverV3Journal()===1`，实际 0）
- 同文件「keeps newly imported records without canonical terminal time explicitly unavailable」

**根因（已亲核属实，非 DI-5 引入、早于它）**：`src/lib/history/v3/store.ts:1228`
```
const recoveredRecord = JSON.parse(decoder.decode(decompressBytes(row.payload_gz))) as ModelOperationRecord
const prepared = prepareModelOperation(recoveredRecord, ...)   // ← recoveredRecord 没过 withDispatchAlias
```
反序列化的 plain object 丢失了 `attempts` 这个**非枚举 getter 别名**（`ModelOperationRecord` 的 `attempts` 是 `dispatches` 的 alias，由 `withDispatchAlias` 在 :415 定义/挂载）。下游 `prepareModelOperation`（:477）→ `projection.ts:201` `record.dispatches.map` / `:246` `record.attempts.length` 读到 undefined → 抛 `record.attempts.length` 错 → recover 的 catch 把它记进 journal.error 列、`recovered` 不自增 → 恒 0。

**对照证据**：`prepareModelOperation`（store.ts:442）、`hydrateManifest`（:1164/:1190）都在反序列化后过了 `withDispatchAlias`，唯独 `recoverV3Journal` 漏了。

**修法**：`recoverV3Journal` 反序列化后先过 `withDispatchAlias` 补回 attempts 别名，再传 `prepareModelOperation`：
```
const recoveredRecord = withDispatchAlias(JSON.parse(decoder.decode(decompressBytes(row.payload_gz))) as ModelOperationRecord)
```
（`withDispatchAlias` 是 file-local 私有函数，同文件直接可用。）

**验收**：store.it.test.ts 上述两测转绿（`recoverV3Journal()===1` + newly-imported timing）；跑 `bun test tests/history/v3/store.it.test.ts` 全绿。TDD：这两测已存在且当前红，直接作为 red→green oracle，不必新写（但确认它们不是被别的既有污染，单跑确认）。

**收尾**：修好后更正 `5c164f0e` 的遗留断言——在 06 台账 DI-5 节标注「journal-first 兜底前提已由 followup-1 修复后成立」。

## Followup-2（MEDIUM）— drain retry 无总耗时上限，极端 config 可 shutdown wedge

**问题**：`src/lib/history/v3/store.ts` 的 `runWithTransientRetry` + config `history.persist_retry {max_attempts, backoff_ms}`。当前 `setV3PersistRetryConfig` 只 floor 下限（maxAttempts≥1、backoffMs≥0），`config/schema.ts` 只非负校验，**无总耗时上限**。retry backoff 是线性（`backoffMs × attempt`），且 shutdown 时**故意不传 abort signal**（避 store→shutdown→state require 循环，见 store.ts 注释）——所以 `drainV3Writer` 会老实等满所有 retry。极端配置（如 `max_attempts=100, backoff_ms=1000` → 线性和 ≈ 5050 秒）会让 shutdown drain 卡到分钟/小时级。

**修法**（建议）：drain 侧加一个**独立总耗时软上限**（不引入 shutdown 依赖）——`runWithTransientRetry` 累计已耗 backoff，超过一个 cap（如 `persist_retry.max_total_ms`，默认几秒）就停止重试、记 failed。或对 `max_attempts × backoff_ms` 的乘积在 config apply 时 warn-clamp。选哪种由 plan 定，但**必须有一个总耗时天花板**，别让 config 能把 shutdown 拖垮。

**验收**：单测——极端 config（大 max_attempts）下 `runWithTransientRetry` 在总耗时 cap 内返回、不超时；drain 在 shutdown 场景有界。用 `setAbortableDelayScaleForTests(0)` 保持测试瞬时、但断言 attempts/累计逻辑而非墙钟。

## 现状锚点（实现前复核行号，代码在漂移）

- `src/lib/history/v3/store.ts`：`withDispatchAlias`(:415)、`prepareModelOperation`(:477)、`recoverV3Journal`(:1225 循环 / :1228 漏点)、`runWithTransientRetry`、`setV3PersistRetryConfig`、`runDrain`。
- `src/lib/history/v3/projection.ts:201/246`（读 dispatches/attempts 的抛错点）。
- `tests/history/v3/store.it.test.ts`（followup-1 的 red oracle）、`tests/history/v3/transient-retry.it.test.ts`（followup-2 可扩展）。
- config：`config/schema.ts`（persist_retry section）、`config/config.ts` applyConfigToState、`config.yaml`。

## 红线（项目通用）

- 中文对话。不 checkout/reset/rm 工作区文件；git add/本地 commit 允许、push 需同意。不启服务器、不 kill 进程。`bun run typecheck` / `bun run test:backend` / `bunx eslint <file>` 验证。
- **并发会话**：本仓库常有并发 agent。精确 pathspec 暂存、`git diff --cached --stat` 对账（数量级不符=污染）。**注意本会话曾误 `git stash pop` 别人的 WIP**——stash 操作前先 `git stash list` 确认栈顶归属。
- 碰持久化不变量：参照 skill `persistence-async-invariants`（drain-before-close / never-throw / 幂等）。TDD 红→绿。改完派异模型 subagent 对抗 review，亲核其 file:line 断言。
- followup-1 是 followup-2 的**先决**（recovery 修好前，journal-first 兜底不成立，retry 的"其余靠 journal 兜"论证悬空）——先做 1 再做 2。

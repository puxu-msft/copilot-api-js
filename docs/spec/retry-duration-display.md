# Spec：终端重试时长显示 `last/total(N)`

## 背景与问题

终端日志行的 duration 字段（如 `621.9s`）来自 [terminal-ui.ts](../../src/lib/tui/terminal-ui.ts) 的 `Date.now() - ctx.startTime`——**整个请求生命周期的墙钟时间**，从请求上下文创建到终态。中间发生的所有重试都在同一个 `ctx` 内、共享同一个 `startTime`，因此该时长**囊括了全部重试**：

- **L1 反应式重试**：`runExchange` 内按 strategy 切换/传输重发（[driver.ts:255](../../src/lib/pipeline/driver.ts#L255)）。
- **L2 缓冲重试**：`protect-streaming-retry`，buffered sink 反复 re-run `runExchange`（[driver.ts:692-709](../../src/lib/pipeline/driver.ts#L692)）。

两层重试都通过 `beginAttempt`（[driver.ts:257](../../src/lib/pipeline/driver.ts#L257)）在同一 `ctx` 上追加一条 `Attempt` 记录（各带独立 `startTime` + `durationMs`）。

**痛点**：当一个请求耗时很长（如 621.9s）时，操作者无法从终端区分「这是最后一次尝试本身慢」还是「重试累加导致总时长长」。**单次尝试耗时目前在终端任何地方都看不到**——连 `[RETRY-N]` 行显示的 elapsed 也是 `Date.now() - ctx.startTime` 的**累计值**（[terminal-ui.ts:447](../../src/lib/tui/terminal-ui.ts#L447)），不是该次尝试的耗时。

> 澄清：日志行中的 `↻100%` 是**提示缓存命中率**（`↻<hit%>`，[format.ts:113](../../src/lib/observability/projections/format.ts#L113)），**不是**重试次数。真正的重试信号是末尾的 `protect-streaming-retry` 标签。

## 目标

在有重试发生时，把 duration 字段从单一 total 扩展为 **`<last>s/<total>s(N)`**：

- `<last>` = 最后一次 attempt 自身的耗时。
- `<total>` = 整个请求墙钟（`now - ctx.startTime`），语义不变。
- `N` = 重试次数。

覆盖三个呈现面，形状统一。无重试（`N=0`）时三面**文本与颜色均严格保持**今天的单一 total（零回归）。

## 关键决策（已与用户敲定）

1. **计数口径**：`attempts[]` 是 L1 反应式与 L2 缓冲重试的并集（都走 `beginAttempt`），`N` **合并计** L1+L2。理由：口径最完整、统一，符合 richest-data-flow。
2. **覆盖面 + L2 可见性**：终端汇总行 + `[RETRY]` 行 + footer/panel 实时面板，**三面全上**。**且 L2 缓冲重试也发 `attempt_failed` 事件、也打 `[RETRY]` 行**（见 §设计-2 BLOCK-1 修正）——真正做到 L1+L2 在三面一致可见，而非 L2 只在汇总 `N` 里"隐身"。
3. **形状**：三面统一 `<last>s/<total>s(N)`；`[RETRY]` 行也带 `(N)`。
4. **前缀简化**：`[RETRY-N]` → `[RETRY]`。重试序号由 triplet 的 `(N)` 承载，前缀里的 `-N` 冗余。
5. **`[RETRY]` 编号 1-based**：`[RETRY]` 行的 `N = attemptIndex + 1`（「这是第 N 次重试」，首次重试显示 `(1)`，贴合今天 `[RETRY-1]` 直觉）。副产品：**末次 `[RETRY]` 行的 `N` 恰等于汇总行总重试数**（末次失败 `attemptIndex = length-2`，`+1 = length-1 =` 汇总 `N`），终态跨面数值天然对齐。
6. **取色**：duration 字段按**实际显示的头部值**的 severity 上色——`retries >= 1 ? durationColor(lastMs) : durationColor(totalMs)`。`N=0` 仍按 `totalMs` 着色，与今天逐字节一致（**修正**了初稿"N=0 时 last===total"的错误断言：`last` 从 `attempt.startTime` 起算、不含队列等待与 ctx 创建间隙，`total` 从 `ctx.startTime` 起算，两者 **N=0 时也不相等**——证据：`queueWait` 是独立的 `(queued Xs)` 列，证明 total 含队列等待而单 attempt 不含）。着色仅施于**汇总行 + `[RETRY]` 行**（见决策 7）。
7. **footer/panel 不着色**：footer 单请求行（[footer.ts](../../src/lib/tui/render/footer.ts)）与 panel 行（[panel.ts](../../src/lib/tui/render/panel.ts)）不给 elapsed 单独着色，整行先以纯文本交给 [width.ts](../../src/lib/tui/render/width.ts) 的 `truncateToWidth`，再在末端施加 dim/reverse 样式。故 footer/panel 显示 triplet **纯文本、保持 dim/无色**，字素截断安全；Region 的二次防御则走 ANSI-safe `truncateAnsiToWidth`。着色只在走 log-line/`durationColor`、不经纯文本截断的汇总行 + `[RETRY]` 行。

## 各面的 `N` 语义

| 面 | `<last>` | `<total>` | `N` | 着色 |
|---|---|---|---|---|
| 终端汇总 `[ OK ]`/`[FAIL]` | `attempts.at(-1).durationMs` | `now - ctx.startTime` | `(attempts?.length ?? 1) - 1`（总重试） | 按头部值 |
| `[RETRY]` 行（某次尝试失败时，L1+L2） | 该失败 attempt 的 `durationMs` | `now - ctx.startTime` | `attempt.attemptIndex + 1`（第几次重试，1-based） | 按头部值 |
| footer/panel 实时（在途） | `now - currentAttempt.startTime` | `now - ctx.startTime` | `attemptCount - 1`（已消耗重试数） | 纯文本无色 |

**跨面 N 一致性**（澄清 reviewer 建议-6）：三处 `N` 中途口径**微异**——footer 的 `attemptCount-1` 把在飞那次算作"已到达"，`[RETRY]` 的 `attemptIndex+1` 是"这次失败触发的第几次重试"，汇总的 `length-1` 是终态总数。三者各自自洽、**终态数值对齐**（末次 `[RETRY]` = 汇总）。运行中 footer 显示 `(k)` 时，正是 `[RETRY](k)` 那条所announce的第 k 次重试在跑，语义连续。

## 设计

### 1. 单一格式化器（SSOT）

在 [format.ts](../../src/lib/observability/projections/format.ts) 新增纯函数，三面共用，**不含颜色**（着色是调用方的独立关注点，与既有 `formatDuration`/`durationColor` 分离一致）：

```ts
export function formatDurationField(args: { lastMs: number | undefined; totalMs: number; retries: number }): string
// retries <= 0                → formatDuration(totalMs)                              例：621.9s（与今天逐字节一致）
// retries >= 1 且 lastMs 有效  → `${formatDuration(lastMs)}/${formatDuration(totalMs)}(${retries})`  例：45.2s/621.9s(2)
// retries >= 1 但 lastMs 无效  → `${formatDuration(totalMs)}(${retries})`             容错兜底，绝不崩
```

`lastMs` 有效判据：`!== undefined && > 0 && <= totalMs`（防脏数据/未定稿的 `0` 初值反常）。

配套一个**着色驱动值**辅助（供调用方选头部值）：`colorMs = retries >= 1 ? (lastMs 有效 ? lastMs : totalMs) : totalMs`。

### 2. BLOCK-1 修正：L2 缓冲重试也发 `attempt_failed` / 打 `[RETRY]`

**现状缺陷**：L2 缓冲重试循环（[driver.ts:692-709](../../src/lib/pipeline/driver.ts#L692)）只调 `onBufferedResolve`/`onAttemptReset`，**从不调 `recordAttemptFailure`** → 不发 `attempt_failed` 事件 → 今天 L2 重试在 `[RETRY]` 行**完全不可见**（全仓 `recordAttemptFailure` 仅 [driver.ts:339](../../src/lib/pipeline/driver.ts#L339) L1 与 legacy pipeline.ts 两处）。

**改动**：在 buffered 循环判定 `retryable && attempt < cap`、`attempt++` 重发**之前**，对刚失败的 L2 attempt：
1. **先定稿其 `durationMs`**——L2 truncation 失败路径既不走 `setAttemptResponse` 也不走 `setAttemptError`，`durationMs` 停在 `beginAttempt` 的初值 `0`（reviewer 建议-7）。需在此显式 finalize（新增一个 ctx 方法如 `finalizeCurrentAttemptDuration()`，或复用既有 setter），否则 `[RETRY]` 的 `last` 会是 0。
2. 调 `currentEnv.ctx.recordAttemptFailure({ willRetry: true, ... })` 发 `attempt_failed`（`AttemptSnapshot` 透传已定稿的 `durationMs`）。

**波及面核对**（plan 阶段验证）：`attempt_failed` 的其他消费者——[ws.ts:111](../../src/lib/observability/sinks/ws.ts) 实时重试遥测（前端将同样看到 L2 重试，符合预期/richest-data-flow）、history sink。须确认无消费者假设 `attempt_failed ⟹ L1-only`。

### 3. 数据管线（补 3 处字段）

| 面 | 数据来源 | 改动 |
|---|---|---|
| 终端汇总行 | `historyEntry.attempts` | **无需补字段**。`attempts[].durationMs` 在 `setAttemptResponse`/`setAttemptError`（[request.ts:527](../../src/lib/context/request.ts#L527)/[544](../../src/lib/context/request.ts#L544)）定稿，`toHistoryEntry` 投影（[request.ts:848](../../src/lib/context/request.ts#L848)）。注意 `attempts` 在零-attempt 终态为 `undefined`（[request.ts:821](../../src/lib/context/request.ts#L821) 仅 `length>0` 才赋值）。 |
| `[RETRY]` 行 | `AttemptSnapshot` 事件 | [events.ts:106](../../src/lib/observability/events.ts#L106) `AttemptSnapshot` 加 `durationMs?: number`；[request.ts:936](../../src/lib/context/request.ts#L936) `recordAttemptFailure` snapshot 透传 `a.durationMs`。顺序已核实安全：L1 路径 `setAttemptError`（driver.ts:292）先于 `recordAttemptFailure`（driver.ts:339）；L2 路径由 §2 显式 finalize 保证。 |
| footer/panel 实时 | **轻量 `RequestContextSnapshot` 顶层标量** | 见下方 BLOCK-plan 修正：footer/panel 的 `entry.ctx` 被高频 `stream_progress` 的**无 summary** 轻量 `snapshot()` 覆盖，故**不能**读 `.summary`。改为给 [events.ts:72](../../src/lib/observability/events.ts#L72) `RequestContextSnapshot` 顶层加 `currentAttemptStartedAt?` + `attemptCount?`，在 [request.ts:281](../../src/lib/context/request.ts#L281) `snapshot()` 填充（每个事件都带、廉价标量）。另在 [activity-summary.ts:16](../../src/lib/context/activity-summary.ts#L16) `RequestActivitySnapshot` 加 `currentAttemptStartedAt?`（服务前端 WS 路径，[summarizeRequestContext](../../src/lib/context/activity-summary.ts#L37) 填充）。 |

> **BLOCK-plan 修正（计划技术审查抓出）**：初稿设想 footer/panel 读 `entry.ctx.summary?.currentAttemptStartedAt`。核实发现 footer/panel 的 `entry.ctx` 在每个事件被 `upsertCtx` 覆盖，而高频 `stream_progress`（[request.ts:917](../../src/lib/context/request.ts#L917)）、`attempt_started`（:931）、`attempt_failed`（:958）用的是**无 `summary`** 的轻量 `snapshot()`（[request.ts:281](../../src/lib/context/request.ts#L281)）——在途请求绝大多数时间 `entry.ctx.summary` 为 undefined，triplet 永不出现且单测因直接注入 `ctx.summary` 而假绿（"测绿生产死"）。故 footer/panel 走**顶层标量**，并须补一条驱动真实 bus + `stream_progress` 的集成测试。

### 4. 三处渲染点

- **[terminal-ui.ts:525](../../src/lib/tui/terminal-ui.ts#L525) `onTerminal`**：`duration` 用 `formatDurationField`，`retries = (historyEntry?.attempts?.length ?? 1) - 1`（**防 undefined，应修-4**），`lastMs = historyEntry?.attempts?.at(-1)?.durationMs`，`totalMs = durationMs`；log-line 的 `durationMs`（着色）字段传 `colorMs`。
- **[terminal-ui.ts:452](../../src/lib/tui/terminal-ui.ts#L452) `onAttemptFailed`**：prefix `[RETRY-${attemptN}]` → **`[RETRY]`**；`duration` 用 `formatDurationField({ lastMs: event.attempt.durationMs, totalMs: elapsedMs, retries: event.attempt.attemptIndex + 1 })`；log-line `durationMs`（着色）传 `colorMs`。
- **[footer.ts:56](../../src/lib/tui/render/footer.ts#L56)（单请求行）+ [panel.ts:195](../../src/lib/tui/render/panel.ts#L195)（`formatPanelRow`）/ [panel.ts:220](../../src/lib/tui/render/panel.ts#L220)（`buildDetailLines`）**：`formatDuration(now-startTime)` → `formatDurationField`，`lastMs = entry.ctx.currentAttemptStartedAt ? now - currentAttemptStartedAt : undefined`（**顶层标量**，非 `.summary`），`retries = (entry.ctx.attemptCount ?? 1) - 1`；**不加色**（决策 7），保持今天的 dim/纯文本。**footer 聚合行**（[footer.ts:123](../../src/lib/tui/render/footer.ts#L123) `oldestStart`，多请求折叠）**保持 total-only 不动**。

### 5. log-line 纯格式化器不改

[log-line.ts](../../src/lib/observability/projections/log-line.ts) 的 `formatLogLine` **保持不变**：调用方把 triplet 作为 `duration` 字符串传入、`durationMs` 传 `colorMs`（驱动 `durationColor`），既有 `durationColorFn(duration)` 机制自然把整个 triplet 按头部值上色。零 formatter 改动。

## 边界与不变量

- **`N=0`（无重试）**：三面**文本与颜色均**严格保持今天单值（`formatDurationField(retries=0)` 返回 `formatDuration(totalMs)`，着色仍按 `totalMs`）。**首要回归不变量**。
- **footer 聚合行**：多请求聚合、无单一 attempt 概念，保持 total-only。
- **零-attempt 终态**：`historyEntry.attempts` 为 `undefined` 时 `retries = (undefined?.length ?? 1) - 1 = 0`，退化为单值，不崩。
- **`lastMs` 缺失/异常（含 L2 未定稿的 `0`）**：兜底为 `total(N)`；配合 §2 的显式 finalize，正常路径下 L2 也有真值。
- **`truncateToWidth` 安全**：footer/panel triplet 纯文本，无 ANSI，截断不腰斩。

## 测试

- `formatDurationField` 纯函数单测：`retries=0` / `retries>=1` 正常 / `lastMs` 无效（undefined、0、>total）三兜底分支；`colorMs` 选值。
- 终端汇总快照：有重试（triplet + 按 last 着色）/ 无重试（单值 + 按 total 着色，逐字节等于今天）/ 零-attempt 终态（不崩、单值）。
- `[RETRY]` 行 golden：prefix `[RETRY]` + triplet + 1-based `(attemptIndex+1)`；**L1 与 L2 各一条**（验证 §2 的 L2 也打 `[RETRY]`）。
- L2 缓冲重试集成测：断言 L2 RST 重发触发 `attempt_failed` 事件、`AttemptSnapshot.durationMs` 非 0（§2 finalize 生效）。
- footer/panel：注入带 `currentAttemptStartedAt` 的快照断言 triplet 纯文本；`currentAttemptStartedAt` 缺失兜底；聚合行不变。
- 回归：更新现有 `[RETRY-N]` / duration 相关快照到新形状（前缀 + triplet + 1-based）。

## 未采纳的备选（record-not-adopted）

- **`N` 仅计 L2**：口径窄、与 `attempts[]` 并集不一致，弃。
- **`[RETRY]` 保持 L1-only、L2 只进汇总 `N`**：L2 重试在滚动日志"隐身"、footer `attemptCount` 跳变无对应日志解释，完整性差，弃（改为 L2 也发 `attempt_failed`）。
- **`[RETRY]` 用 0-based `(attemptIndex)`**：首次重试显示 `(0)` 反直觉、且末次 `[RETRY]` 与汇总 `N` 差 1，弃（改 1-based，末值天然对齐）。
- **双色 triplet**（`last` 段/`total` 段分别着色）：更复杂、收益小，弃；整字段按头部值单色。
- **footer/panel 也着色**：`truncateToWidth` 只接受纯文本，ANSI 会被腰斩，且今天本就无色，弃。
- **spec 放 `docs/superpowers/specs/`**（brainstorming skill 默认）：按项目 CLAUDE.md 文档路由改放 `docs/spec/`。

## 影响的文件

| 文件 | 改动 |
|---|---|
| `src/lib/observability/projections/format.ts` | 新增 `formatDurationField` + 着色驱动值辅助 |
| `src/lib/observability/events.ts` | `AttemptSnapshot` 加 `durationMs?`；`RequestContextSnapshot` 顶层加 `currentAttemptStartedAt?` + `attemptCount?` |
| `src/lib/context/request.ts` | `recordAttemptFailure` snapshot 透传 `durationMs`；新增/复用 attempt duration finalize；轻量 `snapshot()` 填充顶层 `currentAttemptStartedAt`/`attemptCount` |
| `src/lib/context/activity-summary.ts` | `RequestActivitySnapshot` 加 `currentAttemptStartedAt?`（前端 WS 路径） |
| `src/lib/pipeline/driver.ts` | buffered 循环失败分支 finalize durationMs + 调 `recordAttemptFailure`（L2 也发 `attempt_failed`） |
| `src/lib/tui/terminal-ui.ts` | `onTerminal` + `onAttemptFailed`（`[RETRY]` 前缀 + 1-based + triplet + colorMs） |
| `src/lib/tui/render/footer.ts` | 单请求行改 triplet（纯文本）；聚合行不变 |
| `src/lib/tui/render/panel.ts` | 详情行改 triplet（纯文本） |
| 相关测试与 golden 快照 | 更新/新增（含 L2 [RETRY]、零-attempt、N=0 着色回归） |

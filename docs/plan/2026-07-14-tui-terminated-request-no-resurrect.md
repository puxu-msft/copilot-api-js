# 修复计划：TUI 面板对已终止请求永久转圈（error-shaping-decided 晚事件复活死请求）

> **实施状态（2026-07-14）：✅ 已实施并提交 master**
> - `3818c66c` refactor: 抽 `src/lib/history/lifecycle-state.ts` 单一源 primitive，收敛 queries/reaper（改动 2）
> - `a52d0452` fix: `terminal-ui.ts` upsertCtx 加 `isTerminalState` guard + keeper 测试（改动 1，关守卫 4 case 转红证非恒真）
> - `7c0003f9` fix: 修 keeper 测试 tsc 窄 tuple overload
> - `80fc0e53` docs: backlog 记档 producer settle-signal 局限
> - 验证：keeper 13 pass；全量 TUI+footer+history 711 pass/0 fail 无回归；我的文件 typecheck 干净。
> - 经异模型 reviewer 对抗审查（0 blocker），采纳全部 MEDIUM 修正。
> - 「error-shaping-decided tag 无法进 [FAIL] 行」按计划 defer，记 docs/todo/deferred-backlog.md。

---


## Context（为什么做这个改动）

用户报告两个请求（`req_1784029268152_342`、`req_1784029277803_344`）在 TUI 面板里「一直转圈」、代理「没有结束这次请求」。

经实测取证（4141 History API 探针 + 真 `@anthropic-ai/sdk` 复现 + 事件序列录制），定位如下：

- **上游根因**（无争议）：两条 streaming 请求的 prompt 超过模型 1,000,000 token 硬上限（1000604 / 1001278 tokens），GHC 返回 400 `model_max_prompt_tokens_exceeded`。代理**正确地**在 pre-commit（`streamCommitAfterSec=20s` 窗口内，上游 6s 就返回）以干净的 HTTP 400 JSON 结束了请求——真 SDK 复现证明客户端拿到 `BadRequestError` status=400、无挂起。**客户端与 HTTP 层没有 bug。**

- **真正的、唯一的症状**：**TUI 面板永久转圈**。这是纯观测层 bug，不影响客户端、不影响 HTTP 响应、不影响 history 落库（features 本就不进 history entry）。WS sink 用计数器实现、**免疫**此 bug；只有 TUI 用 `Map` + `upsertCtx` 会中招。

### 根因（实测事件序列证实）

```
request.state_changed(failed)
request.failed(failed)                          ← TUI onTerminal: active.delete(ctx.id) 正确移除
request.feature_applied:error-shaping-decided   ← TUI upsertCtx: 把已终止 ctx 重新物化回 active → 永久转圈
```

一个时序事实制造了这个 bug：`error-shaping` 的决策遥测在 `ctx.fail()` **之后**才记录。

- pre-commit 路径：[handler-v4.ts:326](src/routes/messages/handler-v4.ts#L326) 的 catch 先 `ctx.fail()`（发 `request.failed`）→ rethrow → [route.ts:13](src/routes/messages/route.ts#L13) catch → `shapePrecommitError` → [error-shaping-glue.ts:102](src/routes/messages/error-shaping-glue.ts#L102) `ctx.recordFeature("error-shaping-decided")`（发晚到的 `request.feature_applied`）。
- post-commit 路径同构：[handler-v4.ts:514](src/routes/messages/handler-v4.ts#L514) `ctx.fail()` 后，[error-shaping-glue.ts:176](src/routes/messages/error-shaping-glue.ts#L176) 再 `recordFeature`。
- `recordFeature` 只 publish 事件、不写 ctx（[request.ts:994](src/lib/context/request.ts#L994)）；TUI 的 `upsertCtx`（[terminal-ui.ts:385+](src/lib/tui/terminal-ui.ts#L385)）遇到 active map 里没有的 id 就 materialize 一个新 entry——它没有守护「已终止的请求绝不复现为 active」这个它自己拥有的不变量。

### 修复取向（为什么在 TUI 消费侧修）

正解是让 **TUI 守护它自己的不变量**：一个已经 terminal（completed/failed/aborted）的 ctx，绝不因任何晚到的 `request.*` 事件被 `upsertCtx` 复活。理由：

1. **根因在正确的层**：TUI 的 active map 是 TUI 拥有的状态，「已终止≠active」是 TUI 的不变量，应由 TUI 守护。
2. **一处覆盖全类**：同时治 pre-commit + post-commit + 未来任何 producer 在 terminal 后发的晚事件（不止 error-shaping）。
3. **不改动 producer 时序**：error-shaping 在 fail 后记录决策遥测是合理的（telemetry sink 仍正常收到该事件），不应为了 TUI 去重排 handler/route 的 settle 边界。
4. WS sink 已用计数器天然免疫，无需改动；history 不受影响。

> 注：曾考虑「recordFeature 在 settled 后 no-op」与「重排让决策在 fail 前记录」两个 producer 侧方案，取舍见下方「已知局限」小节（前者否决、后者 defer）。

## 设计

Explore 确证的关键事实，让修复收敛到一个极简形态：

- **`upsertCtx`（[terminal-ui.ts:527-546](src/lib/tui/terminal-ui.ts#L527)）是唯一的物化 chokepoint**：全部 6 个会复活的事件（`model_resolved`/`state_changed`/`attempt_started`/`attempt_failed`/`stream_progress`/`feature_applied`）+ `onAttemptFailed` 都经它加入 active。一处 guard = 全类覆盖，无需逐事件改。
- **晚到事件的 ctx 已携带 terminal state**：`recordFeature` 发的 `feature_applied` 其 `ctx.state` 已是 `"failed"`（[request.ts:994-1001](src/lib/context/request.ts#L994) snapshot 读实时 `_state`）。判据现成，**无需新建 terminated-id 集合**——从而彻底绕开「有界集合防内存泄漏」的设计难题。
- **`onTerminal` 已有先例**：entry 不在 active 时它造一个 throwaway entry、用完不回插（[terminal-ui.ts:606-612](src/lib/tui/terminal-ui.ts#L606)）。upsertCtx 的修复完全对称复用这个模式。

### 改动 1（根因修）：`upsertCtx` 拒绝复活已终止的 ctx

在 `upsertCtx` 的「entry 不存在」分支（[terminal-ui.ts:529](src/lib/tui/terminal-ui.ts#L529)）加守护：当 `isTerminalState(ctx.state)` 时，构造 entry 但**不 `active.set`、不 `startFooterTimer`**，直接返回这个 throwaway（与 [onTerminal 的 throwaway 模式](src/lib/tui/terminal-ui.ts#L606) 同构）。调用方拿到合法 entry 照常 mutate（tag push 等），但已死请求绝不重回 active。

- **判据 = 已死请求不再进 active**，state ∈ 全 terminal 集 `{completed, failed, aborted, interrupted}`（含 `completed`——与 [request.ts:813](src/lib/context/request.ts#L813) 的 non-success 子集 `{failed, aborted, interrupted}` 是**不同谓词**，不可混用；guard 落在 missing 分支，正常 terminal `state_changed` 走 else 刷新分支、不受影响）。
- `interrupted` 纯防御性纳入：全仓 grep 无任何 live `transition("interrupted")`，它只在 DB reaper 对死进程行重分类时出现、永不进 live ctx 的 `_state`（故不会出现在 `feature_applied` snapshot 里）。纳入语义正确、前瞻无害，但对本 bug **inert、不承重**。
- 正常流不受影响:streaming 中的 `feature_applied` state=`"streaming"`（非 terminal）→ 照常物化;真正 miss 掉 `created` 的活请求（pending/executing/streaming）→ 照常物化。guard 只挡 terminal,无假阳性。
- **`onCreated` 为何无需 guard**（完整性论证,补 reviewer Q2）:另一个 `active.set` 点是 [onCreated:511](src/lib/tui/terminal-ui.ts#L511),但它安全**不是因为被 guard**,而是因为 `request.created` 恒为生命周期首事件（[manager.ts:247](src/lib/context/manager.ts#L247) 在 create() 内发一次）且其 snapshot state 恒为 `pending`——永不承载 terminal 状态、无复活可能。
- **正面佐证 / 参照实现**:前端 [ui-v4/src/stores/live-store.ts:50](ui-v4/src/stores/live-store.ts#L50) 对 `feature_applied` **已实现**同款守卫（`if (!(id in byId)) return`,注释「id 不存在则 no-op」）。「已终止≠active」是每个 active-map 消费者各自拥有并守护的不变量——三消费者中 WS 计数器免疫、ui-v4 store 已守、**唯 TUI 缺守卫**是异常。本改动让三者对齐。

### 改动 2（消除分区碎片，fix-all-comparison-sites）：抽单一 `ACTIVE_STATES` primitive

reviewer 查出活跃/终止态分区已在仓库**碎裂 3 处**且各自定义:[queries.ts:43](src/lib/history/queries.ts#L43) 私有 `NON_TERMINAL_STATES` Set、[reaper.ts:49](src/lib/history/sqlite/reaper.ts#L49) 私有 `ACTIVE_STATUSES` 数组、[request.ts:813](src/lib/context/request.ts#L813) 内联 non-success 谓词。若再为 TUI 新增第 4 处独立 `TERMINAL_STATES`,未来新增一个 active 态需同步多处、否则某处静默误分类——正是 [[feedback-fix-all-comparison-sites]] 警示的复发模式。且 [history/types.ts](src/lib/history/types.ts) 经核实**零运行时导出、纯 type-only**,放运行时 Set 会破坏该约定。

**做法**:新建运行时模块 `src/lib/history/lifecycle-state.ts`,以 `ACTIVE_STATES = ["pending","executing","streaming"] as const` 为**唯一源**,派生导出:`isActiveState(s)` / `isTerminalState(s) = !isActiveState(s)`（供 TUI guard）、`NON_TERMINAL_STATES` Set（替换 queries.ts 私有定义）;reaper.ts 的 SQL `ACTIVE_STATUSES` 数组亦从此源取。收敛 queries + reaper + TUI 三处消费同一源。

`request.ts:813` 的 non-success 谓词是**第三种**分区(terminal 去 completed,服务 reaper `FAILURE_WHERE`),语义不同、不强并入本次;仅在新模块注释点明三分区层次(active / terminal=补集 / non-success-terminal),防后人再误当同一集。

> 退化方案(若用户认为跨 queries/reaper 收敛超本 bug 范围):仅新建 primitive 供 TUI + 加穷尽 partition 断言测试,queries/reaper 暂留私有(记 backlog)。按 `best-complete-solution` + `fix-all-comparison-sites` 推荐一次收敛到位。

### 已知局限（本次不修，记档）

`error-shaping-decided` tag 因在 `onTerminal` 打印 `[FAIL]` 行**之后**才到达,本就无法出现在完成日志行里(无论有无本 bug)。**这与转圈 bug 同一根因**:feature 在 `ctx.fail()` settle 之后才记录。长远正确形状是 **producer 侧在 `ctx.fail()` 之前记录 error-shaping 决策**(契合 [[methodology-record-signals-at-committed-outcome-not-per-attempt]] / settle 冻结快照模式),使其既进冻结 snapshot、又能出现在完成行,一举同治。

但 **TUI guard(改动1)仍须保留为通用防御层**——其他 producer 也可能在 terminal 后发晚事件,不能依赖每个 producer 都在 settle 前记录。故:本次落 TUI guard(治转圈、通用);tag-into-[FAIL]-行 的 producer 侧重排记 [docs/todo/deferred-backlog.md](docs/todo/deferred-backlog.md),按「settle 前记录 error-shaping 决策」根因形状表述。

> 未采纳方案(记档):① 「recordFeature settled 后 no-op」——会真丢 telemetry sink 对该决策的观测,**否决**;② 「producer 侧重排 fail 时序」——不丢 telemetry(事件仍发、只提前),是正解形状但跨层 settle 边界、改动面大,本次 **defer 而非否决**。

## 关键文件

- **新增** `src/lib/history/lifecycle-state.ts` — `ACTIVE_STATES` 单一源 + `isActiveState`/`isTerminalState`/`NON_TERMINAL_STATES`（改动 2）。
- [src/lib/tui/terminal-ui.ts](src/lib/tui/terminal-ui.ts) — `upsertCtx` 加 `isTerminalState(ctx.state)` guard（改动 1）。
- [src/lib/history/queries.ts](src/lib/history/queries.ts) / [src/lib/history/sqlite/reaper.ts](src/lib/history/sqlite/reaper.ts) — 改为消费新 primitive（改动 2 收敛）。
- 新增 keeper 测试（见验证）。

## 验证

### 1. Keeper 单元测试（新增）

新增 `tests/tui/terminated-no-resurrect.unit.test.ts`（或并入既有 TUI 测试）：构造 `TerminalUi(bus, {...})`，publish 序列 `request.created` → `request.failed`（terminal）→ `request.feature_applied`（ctx.state=`"failed"`），断言该请求**不再出现在 active/footer**。

- 主 oracle:反射 `(ui as any).active.size === 0`（本 bug 的精确不变量;此前无测试反射 active，但这是最直接判据）。**参数化全 terminal 态** {completed, failed, aborted} 逐一断言（interrupted 可选、注明 live 不可达）——防未来误删 `ACTIVE_STATES` 某成员时单一 failed case 逮不到（partition 碎裂的主回归面）。
- **throwaway 契约断言**:terminal case 下 `upsertCtx` 仍须返回一个**可 mutate 的 entry**（模拟 tag push 生效），守住「返回可用 entry、只跳过 active 插入」这一半契约,而非只测「不插入」。
- 辅 oracle:强制 footer 渲染后断言 `[<-->]` 段不含该请求（mirror [console-footer.unit.test.ts](tests/observability/console-footer.unit.test.ts) 的 footer-string 手法），即用户可见的「无 spinner」。
- **正样本对照**（防恒真）:另一 case 用 state=`"streaming"` 的 `feature_applied`（非 terminal），断言仍正常物化进 active——证 guard 真按 state 分流、非恒拒。
- post-commit 与 pre-commit 同机制（`feature_applied`@state=failed）,failed case 已覆盖,加注释说明即可,无需单独 case。
- **`isTerminalState` primitive 单测**:穷尽 `RequestLifecycleState` 全 7 态断言 active/terminal 分区（守住 `ACTIVE_STATES` 单一源的正确性 + partition 完备）。

### 2. 端到端复现回归（可选，投资更高）

沿用调查期已验证有效的 harness 手法（真 `@anthropic-ai/sdk` + serve-in-process + `setUpstreamFetchForTests` 回精确 400 + 挂真 `TerminalUi` 到同 bus），断言 fail 后 `active.size===0`。调查期该探针已实测复现 bug（修前 size=1）;可保留为 `.it` 回归或合入改动 1 后确认转绿。

### 3. 全量 TUI 测试不回归

`bun test tests/tui tests/observability/console-footer.unit.test.ts` 全绿（golden-fixture 等确认无字节回归）。

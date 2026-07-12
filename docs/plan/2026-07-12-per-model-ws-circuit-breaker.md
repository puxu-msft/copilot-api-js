# Plan — 上游 WS 熔断器 per-model 化（A）

> **实施状态（2026-07-12）**：已落地 master（commit a28d9d89）。manager per-key 化 + 消费端 threading + /api/status per_model + rollup + 迁移 43 既有测试 + per-model 隔离/懒删/snapshot 新测试。typecheck/lint/ui-v4 绿、19 单测过。

> 状态：草稿，待 subagent 对抗评审 → 用户审 → 实施。
> 源起：2026-07-12 生产日志分析。gpt-5.5 的 responses 请求走上游 WS 时被 GHC 服务端 `close(1000, "idle timeout")` 系统性掐断（pre-first-event 长 reasoning 静默），触发熔断器把 WS 路径**整体**禁用 5 分钟——连坐了本来 WS 好用的其他模型。
> 关联但正交：C（WS-ping 实验）另派后台 agent，gate「是否值得写上游 WS ping 保活」，**不在本计划范围**。本计划只做熔断器 per-model 化，不依赖 C 的结论。

## 问题（真缺陷，与 gpt-5.5 无关）

`src/lib/openai/upstream-ws.ts` 的 `createUpstreamWsManager` 闭包里，熔断状态是**两个全局标量**：

```
let consecutiveFallbacks = 0
let disabledUntil = 0
```

任一模型在 WS 上连续失败 3 次（`MAX_CONSECUTIVE_WS_FALLBACKS`），就把**所有** responses 模型的 WS 路径禁用 `DISABLE_RECOVERY_WINDOW_MS`（5 分钟）。后果：

1. **连坐**：gpt-5.5（长 reasoning、WS 系统性失败）拖垮 gpt-4.1 等短 reasoning 模型的 WS 优势，后者被迫走 HTTP。
2. **周期性延迟惩罚扩散**：每 5 分钟的半开探测固定牺牲一个请求；全局化让这个牺牲可能落在**任意**模型头上，而非只有真正坏的那个。

理想形状：熔断按 `modelId` 隔离。gpt-5.5 自己退出 WS、自己承担半开探测成本；其他模型的 WS 判定完全不受影响。这也正是 `docs/todo/deferred-backlog.md` 里 `PerModelOverloadGovernor` 记的方向在 WS 熔断维度的落地。

## 不变量（实现须逐条守）

- **I0 隔离键统一（承重 · BLOCKER 修复）**：熔断的「模型键」在**全部触点取自同一个 payload 对象的裸 `model` 串**，否则 I1/I4 是空的。现状发散（评审 B1 实证）：写侧 `recordFallback`/`findReusable`/`create` 收 `wire.model`（字符串），而门 `canUseUpstreamWebSocket(model: Model)`（`upstream-ws-attempt.ts:58`）收 **Model 对象**、只能读 `.id`——legacy 路径 `wire.model`（客户端原始别名，`request-preparation.ts` 不改写）与 `resolvedModel.id`（规范化 id）**实证不等**。修复靠**同源 threading**（非归一化）：
    - **键 = 连接池已用的裸模型串**。连接池 reuse-match 用 `connection.model !== model`（`upstream-ws.ts:127/152`）裸串比较；熔断键必须**同键空间**——直接用 `prepared.wire.model`（= attempt 读的 `responsesPayload.model` = `wire.body.model`，三者同一字符串），**不套 `normalizeModelId`**（评审实测：`VERSIONED_RE` 只匹配 `claude-*`，对 gpt-5.5 等失败模型是 identity、零别名合并收益，反而与池裸串键空间 skew——见「不做/推迟」的别名合并项）。
    - **gate===write 靠两侧取自同一 payload 对象保证**。门 `canUseUpstreamWebSocket` 加 `modelKey: string` 参数（能力检查仍用 Model 做 `isWsResponsesSupported`，熔断查询用 `modelKey`）。**两个门调用点的 `wire` 是不同类型的同名变量**（评审 H-new 实证）：
        - `responses-client.ts:67`：`wire = prepared`（`ResponsesPayload`，有 `.model`）→ 传 `wire.model`；attempt 读 `prepared.wire.model` = 同串。**gate===write ✓**。
        - `responses-transport.ts:86`：`wire = PreparedRequest`（**无 `.model`**，`pipeline/types.ts:94-99`），模型串在 `responsesPayload = wire.body as ResponsesPayload`（`responses-transport.ts:78`）→ 传 `responsesPayload.model ?? ""`；attempt 收的正是 `{ wire: responsesPayload }`（`:88`），读同一 `responsesPayload.model`。**gate===write ✓**。
    - **M5 空值兜底**：`responsesPayload.model` 类型为 `string | undefined`，门传参前 `?? ""`；Model 为 undefined 时 `isWsResponsesSupported` 已返 false、门整体 false，熔断查询对任意字符串键返回干净默认，安全。
    - **独立 oracle**：写键与门键因均源自同一 payload 对象的 `.model` 而结构等价——测试锁「门读的是 payload 的 `.model` 而非 `resolvedModel.id`」，对 legacy 别名样本证「门键 === attempt 写键」（正样本证发散已被消除）。
- **I1 隔离**：模型 M（以裸 `wire.model` 为键）的 `recordFallback`/`recordSuccessfulStart` 只改 M 的熔断状态，绝不影响其他键的 `temporarilyDisabled`/`consecutiveFallbacks`/`disabledUntilMs`。
- **I2 半开语义不变**：per-model 窗口的「至多连续武装两次（首次越阈 + 半开探测失败）、之后自然过期放行新探测」语义与现全局版逐字一致（见 `recordFallback` 现注释），只是作用域收窄到单键。
- **I3 全局副作用仍全局**：`stopped`（shutdown）、连接池（`connections`/`lastUsedAt`/`evictOneIdleIfNeeded`/`maxConnections` 软上限）、`closeAll` 是**连接级**关注点，**保持全局**，绝不 per-model 化（池上限是资源约束、与熔断正交）。**注意 `resetRuntimeState`（`upstream-ws.ts:202-207`）现重置两标量，per-model 化后须改 `breaker.clear()`**（M4）。
- **I4 findReusable 门 per-model**：`findReusable` 现 line 120 `if (Date.now() < disabledUntil) return undefined` 的全局门，改为按传入的 `model`（裸 `wire.model`，与其 reuse-match 同键）判 per-model disabled（`findReusable` 的 `model` 入参已是 `wire.model`，`upstream-ws-attempt.ts:99`）。
- **I5 richest-data-flow**：`/api/status` 后端暴露 **per-model 明细**（`per_model` 映射，每键 `consecutive_fallbacks`/`temporarily_disabled`/`disabled_until_ms`）。顶层三标量改为 aggregate rollup（`temporarily_disabled`=任一键 disabled、`consecutive_fallbacks`=最大值、`disabled_until_ms`=最晚）。**订正评审 H3**：这三个标量**当前零消费者**（全仓 grep 唯一命中是 `upstream-ws.ts:217` 注释；ui-v4 只读 `enabled`+`active_connections`，`OverviewLegacy/Shadcn.tsx`），保留 rollup 是**语义完备预留**而非「现有摘要行在用」；`per_model` 才是真正新增。ui-v4 status 类型 `upstream_ws?: Record<string, unknown>`（松散），加 `per_model` 不破 `typecheck:ui-v4`——故这不是 lockstep 硬门。→ ADR `docs/decisions/2026-07-05-richest-data-flow.md`。
- **I6 空闲回收 + 懒删红线（评审 L6：经查健全，须写死为红线）**：`recordSuccessfulStart(key)` 是 map 条目的**唯一删除点**（取干净懒删：成功首事件后重置为干净即删条目，只有「正在失败/正在禁用」的键占槽——天然有界于近期失败过的键数）。**红线**：绝不加「读路径清扫干净条目」的优化——因为 `recordSuccessfulStart` 只在成功首事件后到达（`upstream-ws-attempt.ts:166`），而到达 attempt 必过 `canUseUpstreamWebSocket` 门；键 disabled 时门 false → attempt 不可达 → **disabled 窗口内条目绝不被删**，`wasDisabledRecently = disabledUntil>0`（`upstream-ws.ts:235`）在整个 episode 内被条目持续承载，半开语义完整。若后人加读路径清扫会打破此不变量。

## 设计

### 数据结构
把两个标量换成一个 per-key 记账 map（键 = 裸模型串 `wire.model`，I0）：

```ts
interface WsBreakerEntry { consecutiveFallbacks: number; disabledUntil: number }
const breaker = new Map<string, WsBreakerEntry>()
```

- 无条目 = 干净态（0 fallback、未禁用）。读路径对缺失 key 返回干净默认，不建条目（避免读放大 map）。
- 写路径（`recordFallback`）按需建条目；`recordSuccessfulStart` 删条目（I6 懒删）。
- `resetRuntimeState` 改 `breaker.clear()`（M4）。

### API 变更（`UpstreamWsManager` 接口）
`recordFallback`/`recordSuccessfulStart` 加 `key: string` 参数（调用方传裸 `wire.model`）；三个只读 getter 改成按 key 查询的方法（返回类型不变）：

| 现（全局标量/getter） | 新（per-key） |
|---|---|
| `recordFallback()` | `recordFallback(key: string)` |
| `recordSuccessfulStart()` | `recordSuccessfulStart(key: string)` |
| `get consecutiveFallbacks: number` | `consecutiveFallbacks(key: string): number` |
| `get temporarilyDisabled: boolean` | `temporarilyDisabled(key: string): boolean` |
| `get disabledUntilMs: number` | `disabledUntilMs(key: string): number` |

新增用于 status 聚合的只读全量视图（richest-data-flow，I5）：

```ts
breakerSnapshot(): Array<{ model: string; consecutiveFallbacks: number; temporarilyDisabled: boolean; disabledUntilMs: number }>
```

`activeCount`/`stopped` 保持不变（全局，I3）。`findReusable`/`create` 签名不变（仍收 `wire.model`），只是 `findReusable` 内部 disabled 门改用传入的 `model`（= `wire.model` 裸串，与其 reuse-match 同键）查（I4）。

### 门控 threading（消费端 · I0 键同源，非归一化）
- `canUseUpstreamWebSocket` 加 `modelKey: string` 参数：`canUseUpstreamWebSocket(model: Model | undefined, modelKey: string)`。能力检查仍 `isWsResponsesSupported(model)`；熔断查询 `!manager.temporarilyDisabled(modelKey)`。
- **两个门调用点的 `wire` 异型（评审 H-new）**：
    - `responses-client.ts:67`（`wire = prepared`，`ResponsesPayload`）：`canUseUpstreamWebSocket(opts?.resolvedModel, wire.model)`。
    - `responses-transport.ts:86`（`wire = PreparedRequest`，**无 `.model`**）：`canUseUpstreamWebSocket(model, responsesPayload.model ?? "")`（`responsesPayload = wire.body as ResponsesPayload`，`:78`；即 attempt 同源对象）。
- `upstream-ws-attempt.ts` 内（`wire = prepared.wire` = `ResponsesPayload`）：`recordFallback()`（line 114、189）→ `recordFallback(wire.model)`；`recordSuccessfulStart()`（line 166）→ `recordSuccessfulStart(wire.model)`；日志 `(${manager.consecutiveFallbacks}/3)` → `(${manager.consecutiveFallbacks(wire.model)}/3)`。
- `findReusable` 内部门（I4）：`disabledUntil` 全局读 → 按传入 `model`（裸串）读该键 `disabledUntil`。
- **全仓复核**（评审要求）：`temporarilyDisabled`/`consecutiveFallbacks`/`disabledUntilMs`/`recordFallback`/`recordSuccessfulStart` 的其余引用只在 `status/route.ts` 与测试——实施时 grep 全仓逐处改。

### status wire shape（`src/routes/status/route.ts:220-226`）
现顶层 `upstreamWs` 对象里 `consecutive_fallbacks`/`temporarily_disabled`/`disabled_until_ms` 三个标量（**评审 H3 证：零消费者**）：
- **改为**：`active_connections` 保留（全局）；新增 `per_model: breakerSnapshot()` 映射为 wire 形状；顶层三标量改为 aggregate rollup（any/max/latest，语义完备预留）。
- ui-v4/TUI 对这三字段零引用（`OverviewLegacy.tsx`/`OverviewShadcn.tsx` 只读 `enabled`+`active_connections`；`upstream_ws?: Record<string, unknown>` 松散类型）→ 加 `per_model` 不破 `typecheck:ui-v4`，**无 lockstep 硬门**。如未来要 per-model 展示可读新字段。

## TDD（**迁移**既有 `tests/responses/upstream-ws.unit.test.ts` —— 订正评审 H2：非 greenfield）

该文件现有 43 处旧零参 API 调用（熔断阈值 `:99-113`、半开 frozen 语义 `:115-159`、`disabledUntilMs` `:161-179`/`:356-380`），签名改动后**全部编译失败 + 断言失效**，必须**改写迁移纳入 Phase 1**（每处补裸串键，如 `"gpt-5.5"`），不是新建。连接池 eviction 测试（`:181-258`、`:278-309`，`create`/`findReusable` 签名不变）保留。新增/改写测试：

1. **I0 键同源（承重）**：门读的是 payload 对象的 `.model`（`wire.model` / `responsesPayload.model`）而非 `resolvedModel.id`；对 legacy 别名样本（客户端发别名/日期后缀）证「门键 === attempt 写键」（均为同一 payload `.model` 裸串），且与 `resolvedModel.id` 发散的场景下门仍与写侧一致（正样本证发散已消除）。
2. **I1 隔离**：键 A 连续 3 次 `recordFallback("A")` → `temporarilyDisabled("A")===true` 且 `temporarilyDisabled("B")===false`、`consecutiveFallbacks("B")===0`。
3. **阈值**（迁移 `:99-113`）：A 第 1、2 次不禁用；第 3 次禁用。
4. **I2 半开**（迁移 `:115-159`）：禁用窗内再 `recordFallback("A")` 不延长（frozen）；`now` monkeypatch 推进过窗 → `temporarilyDisabled("A")===false`；探测失败 → 重新武装一次；再过窗仍放行。逐条对齐现语义。
5. **I6 懒删 + 成功重置**：`recordSuccessfulStart("A")` 后 `consecutiveFallbacks("A")===0`、`temporarilyDisabled("A")===false`，且 A 条目从内部 map 删除（`breakerSnapshot()` 不含 A）。
6. **I4 findReusable 门**：A disabled 时 `findReusable({model:"A",...})` 返回 undefined；同刻 `findReusable({model:"B",...})` 正常返回可复用连接（复用现文件 `:278-309` 的 fake connectionFactory 造连接模式）。
7. **I5 snapshot**：多键混合态下 `breakerSnapshot()` 返回每键正确三元组；干净键不出现。

时序测试沿用文件现有 `Date.now` monkeypatch 模式（`:116-118`），非 bun fake timers。按项目纪律对 flaky 风险连跑确认确定性。

## 阶段

- **Phase 1**：manager per-key 化（裸模型串键）+ **迁移改写** `upstream-ws.unit.test.ts`（TDD）。交付：`upstream-ws.ts` + 迁移后测试绿、`typecheck` 绿。
- **Phase 2**：消费端 threading（`canUseUpstreamWebSocket` 加 `modelKey` 参数 + 两门调用点异型取键、`upstream-ws-attempt.ts` record/日志/findReusable 门、`status/route.ts` 加 `per_model` + rollup）。交付：`typecheck` + `typecheck:ui-v4` + `lint:all` 绿，`/api/status` 手验 `per_model` 出现。

## 不做 / 推迟（record-not-adopted）

- **上游 WS ping 保活**：gate 在 C 实验，独立特性，不在本计划。
- **让 gpt-5.5 直接不走 WS（选项 B）**：用户本轮未选；per-model 熔断已让 gpt-5.5 自动退出 WS（3 次失败后自禁用、且只惩罚自己），B 的「彻底消除首字延迟惩罚」是增量优化，记 backlog。
- **per-endpoint 再细分**（backlog `PerModelOverloadGovernor` 开放问题）：默认否，key 只到裸模型串。
- **跨别名共享熔断裁决**（「同一上游模型的不同客户端别名合并到一个熔断键」）：评审 MEDIUM 记录——本可用 `resolveModelName`（**非** `normalizeModelId`，后者只归一 Claude dash-版本、对 gpt 失败模型是 identity）实现，但正确做法须**同时**把连接池 reuse-match（`upstream-ws.ts:127/152` 现裸串比较）也切到同一归一键，否则熔断与池键空间 skew。这是独立于本 BLOCKER 的真实扩展（against-yagni 之外），当前**不做**：本次用裸串键即已达成 per-model 隔离目标；若未来要别名合并，单列决策/ADR 且熔断+池同步切键。
- **熔断状态热重载/持久化**：进程内瞬态，重启清零，符合现语义，不改。

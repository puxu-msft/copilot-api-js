# Spec: Live 在途浮窗(LiveDock)与 active-request wire SSOT

状态:draft(待实施)· 日期:2026-07-08 · 归属:ui-v4 请求列表页 + observability WS wire 类型

## 1. 问题 / 动机

`ui-v4` 请求列表页 [RequestsListPage](../../ui-v4/src/components/requests/RequestsListPage.tsx) 把在途泳道 [LiveLane](../../ui-v4/src/components/requests/LiveLane.tsx) 放在 flex 流内、`RequestFilterChips` 与 `HistoryList` 之间。它固定占 `header + max-h-[150px]` 的高度:

- **偷高度**:无论有无在途请求都占掉表头 + 一行(idle 态)或整 150px(busy 态),挤压 History 的可视高度;busy 态 150px 既太厚又只能内滚。
- **信息太少**:每个在途行只渲 `state / model / durationMs` 三列([RequestRow.tsx `LiveRow`](../../ui-v4/src/components/requests/RequestRow.tsx#L58-L82)),而后端 wire 上其实携带远多的字段(见 §5)。

> 事实校准(来自评审):LiveLane 已有 `max-h-[150px] overflow-y-auto`,并非无界增长;痛点是「固定 150px 既太厚又太挤且无明细」,而非「无限顶下去」。

用户诉求:把在途区改成**底部停靠、点击向上展开的浮窗**;折叠只显摘要;展开显示分组汇总 + 富明细;没有在途请求时保留一条纤细空闲条。

## 2. 目标 / 非目标

**目标**
1. 在途区不再随在途条数改变 History 的布局高度(核心)。
2. 折叠态:底部一条**恒高**摘要条(有在途显聚合摘要,idle 显纤细空闲条)。
3. 展开态:向上叠加浮层,**按 resolved model 分组汇总 + 每请求富明细**,信息量远超现状。
4. 把后端已在 wire 上发送、前端当前**丢弃**的富字段(含实时重试遥测)接线到 UI —— richest-data-flow。
5. 建立 active-request 的 wire 类型 SSOT:后端定义一次、前端 `~backend/*` type-only re-export,消除现有双源。

**非目标 / 显式推迟**(记入 [deferred-backlog](../todo/deferred-backlog.md),不静默砍)
- per-group 折叠(小 N 价值低)。
- 请求终态时的淡出动画。
- 面板内直接 abort(abort 交互留在详情页)。
- 展开态下键盘焦点行被叠加层遮挡时的自动滚入(见 §6 已知限制)。

## 3. 布局(根治「偷高度」)

[RequestsListPage](../../ui-v4/src/components/requests/RequestsListPage.tsx) 重构为:

```
<div class="flex h-full min-h-0 flex-col">
  <RequestsFilterBar/>
  <RequestFilterChips/>
  <div class="relative flex-1 min-h-0">        ← 定位锚(overlay 宿主)
     <HistoryList/>                            ← 占满整块高度
     {expanded && (
       <LivePanel class="absolute inset-x-0 bottom-0 z-10 max-h-[55%] overflow-auto"/>
     )}
  </div>
  <LiveDockBar/>                               ← 流内、恒高一行
</div>
```

不变量:
- **DockBar 恒高**:单行 + `whitespace-nowrap` + 固定高(如 `h-6`) + `overflow-hidden`;idle↔active 文案变化、位数增长、窄屏都**不得改变其高度**(否则 `flex-1` 的 History 高度跳变 = 推挤)。这是「不偷高度」的 CSS 硬保证,不是断言。
- **LivePanel 是 overlay,不参与 flex 流**:`absolute bottom-0` 对齐 relative 容器底(= History 底、DockBar 顶),`z-10` 压过行内 `toc-flash` / 选中态定位上下文,`max-h-[55%]` + 内部滚动。
- History 高度 = 区域高度 − DockBar 恒定高,**与在途条数无关**。

叠加取舍(评审确认可接受):History 最新行在**顶**、`endReached` 加载更多在**底**;底部 55% overlay 盖住的是最旧行 + load-more 触发带 + 滚动条下半,**不遮最新行 / tail-follow**。`endReached`/`atTopStateChange` 基于滚动位置,不受遮挡影响。

## 4. 折叠条(LiveDockBar)

- 有在途:`● {N} in-flight · ⚡{s} streaming · ↻{r} retrying · oldest {elapsed}   ▲`
- idle:`○ idle · 0 in-flight`(展开箭头隐藏或禁用,`aria-expanded` 反映状态)
- 点击切换展开;展开态持久化到 localStorage(与列可见性同款,写入失败吞并 `console.warn`)。
- `oldest` / 每行 `elapsed` **由 `startTime` 客户端现算并 1s 滴答**;绝不用冻结的 `durationMs` 或后端时钟 `lastUpdatedAt`(跨前后端时钟偏移)。
- `retrying` 计数来源:在途集合里带有活跃重试态(见 §5.3 reducer 合并的 `willRetry`/attempt 信号)的请求数。

## 5. 数据 / 类型架构(SSOT + richest-data-flow)

### 5.1 现状双源(评审查证)

- 后端**无 wire 类型**:`notifyActiveRequestChanged(data: unknown)`([broadcast.ts](../../src/lib/ws/broadcast.ts))、`requestPayload(): Record<string, unknown>`([ws.ts:225](../../src/lib/observability/sinks/ws.ts#L225))全程 untyped。
- `connected` 快照工厂 [start.ts:400-411](../../src/start.ts#L400-L411) 手搓贫化子集(id/endpoint/rawPath/state/startTime/durationMs/model/stream),漏 attemptCount/currentStrategy/queueWaitMs/transport/active/lastUpdatedAt/clientModel/resolvedModel → **WS 重连后已在飞行的行,富列全空**直到下次 `state_changed`。
- 前端 [types/ws.ts](../../ui-v4/src/types/ws.ts) 手维护 `ActiveRequestInfo`(只声明子集)+ `ActiveRequestChangedInfo`(**未建模** `attempt_failed`/`feature_applied` 的富 payload),`applyActiveEvent` 把它们当 `!request` no-op 丢弃([live-store.ts:24-25](../../ui-v4/src/stores/live-store.ts#L24-L25))。

### 5.2 目标:单一 wire 类型 + 统一 builder

**新增纯 types-only 模块**(不 import `~/lib/state`,例 `src/lib/observability/active-request-wire.ts`),定义:

- `ActiveRequestWire` = `RequestActivitySnapshot`([activity-summary.ts:16-31](../../src/lib/context/activity-summary.ts#L16-L31))所有字段 **+** `method` / `path` / `clientModel?` / `resolvedModel?` / `requestBodySize?` / `multiplier?`(后四者当前不在 `summary` 里,builder 须显式补)。
- `ActiveRequestChangedWire` = 判别联合,逐一建模 7 个 action:
  - `created` / `state_changed`:`{ action, request: ActiveRequestWire, activeCount }`
  - `completed` / `failed` / `aborted`:`{ action, requestId, activeCount }`
  - `attempt_failed`:`{ action, requestId, attempt, strategy?, willRetry, nextStrategy?, waitMs, learning?, error? }`(对齐 [ws.ts:106-117](../../src/lib/observability/sinks/ws.ts#L106-L117);`error` 形状取 [AttemptSnapshot.error](../../src/lib/observability/events.ts#L115))
  - `feature_applied`:`{ action, requestId, feature: FeatureKind, detail? }`(`FeatureKind` type-only 引自 [events.ts:119](../../src/lib/observability/events.ts#L119))
- `ConnectedWire.activeRequests: ActiveRequestWire[]`。

**统一 builder**:in-flight → wire 只有一条纯函数链 `requestPayload(snapshotWithSummary(ctx))`(复用两个既有纯函数,[snapshotWithSummary](../../src/lib/context/activity-summary.ts#L112-L130) 已把 live `RequestContext` → 带 summary + method/path/clientModel/resolvedModel/multiplier/requestBodySize 的 `RequestContextSnapshot`):
- `connected` 工厂([start.ts:400](../../src/start.ts#L400))改用它,替换手搓子集。
- `requestPayload`([ws.ts:225](../../src/lib/observability/sinks/ws.ts#L225))**补齐 `requestBodySize` / `multiplier`**(当前只 spread `summary` + method/path/clientModel/resolvedModel,漏 requestBodySize);返回类型收窄到 `ActiveRequestWire`。
- `notifyActiveRequestChanged` 入参收窄到 `ActiveRequestChangedWire`。

**前端**:[types/ws.ts](../../ui-v4/src/types/ws.ts) 删手维护类型,改为 `~backend/*` **type-only** re-export(活证据:[types/index.ts:3-17](../../ui-v4/src/types/index.ts#L3-L17) 已如此且 build 通过)。

> 放置铁律:wire 类型必须在**无 `~/lib/state` 运行时依赖**的模块。`activity-summary.ts` 因 `summarizeRequestContext` 值导入 `state`([:8](../../src/lib/context/activity-summary.ts#L8)),**绝不可**把 wire 类型放它里面。builder 函数(有 state 依赖)留后端,只有**类型**跨端。

### 5.3 reducer 合并瞬时态(前端 live-store)

[applyActiveEvent](../../ui-v4/src/stores/live-store.ts#L14) 扩展:
- `attempt_failed`(requestId-only):把 `{ attempt, strategy, willRetry, nextStrategy, waitMs, learning, error }` 合并进 `byId[requestId].retry`(transient 子对象),不存在该 id 则 no-op。下一个 `state_changed`(新 attempt 携新 summary)刷新/清除该瞬时态。
- `feature_applied`(requestId-only):把 `{ feature, detail }` 追加进 `byId[requestId].features[]`(累积)。
- terminal(completed/failed/aborted)仍整条移除。

面板/折叠条据此展示:`↻ retrying · next: {nextStrategy} · 等 {waitMs}`、已应用特性 chips、`×{attempt} {strategy}`。

## 6. 展开面板(LivePanel)——分组汇总 + 明细

- **分组键 = resolved model**,pending 未 resolve 时回退 `clientModel`(仍无则 `resolving…`);endpoint 不作分组维度但保留在明细行(避免同模型跨 endpoint 混组丢信息)。
- **小 N 优雅退化**:`≤1` 组或 `N=1` 时扁平 oldest-first、不显组头。
- 组头:`{model} ×{count} · ⚡{streaming} · oldest {elapsed}`。
- 明细行(每请求一行,富字段,窄屏用固定 px 宽 + `overflow-hidden` ellipsis,同 [HistoryRow](../../ui-v4/src/components/requests/RequestRow.tsx#L85) 手法):
  `◐ {state} · {elapsed 滴答} · {endpoint} · {clientModel→resolvedModel 若不同} · ×{attempt} {strategy} · q:{queueWaitMs} · ⚡stream · {requestBytes} · {transport}`;有活跃重试态时追加 `↻ next:{nextStrategy} 等{waitMs}`。
- 组间 / 组内均 oldest-first;点明细行 `navigate(/requests/:id)`(不变)。
- **a11y**(对齐 HistoryList 既有标准):明细行 `role=button` + 键盘可激活;DockBar toggle 带 `aria-expanded`;`Escape` 收起面板。
- **性能**:LivePanel 非虚拟化,1s 滴答会重渲全部在途行 → 明细行按 `id` + 相关字段 `React.memo`,tick 订阅隔离在 LiveDock 子树,**绝不触发 OverviewPage 重渲**([OverviewPage](../../ui-v4/src/components/overview/OverviewPage.tsx) 也订阅 live-store)。
- **已知限制**:展开态下,若键盘焦点行落在被 overlay 遮住的底部区域,会「有 DOM 焦点但视觉不可见」。本次以 `Escape` 收起 + 记 backlog 缓解,不做自动滚入。

## 7. 文件增删

新增:
- `ui-v4/src/components/requests/LiveDock.tsx`(DockBar + Panel 容器,替代 LiveLane)
- `ui-v4/src/components/requests/LiveGroup.tsx`(组头 + 明细行)
- `ui-v4/src/lib/live-summary.ts`(纯聚合:count/streaming/retrying/oldest/分组;bun 单测)
- `ui-v4/src/hooks/useNowTick.ts`(1s 滴答,gated on active>0,隔离订阅)
- `src/lib/observability/active-request-wire.ts`(纯 types-only wire 联合)

修改:
- `ui-v4/src/components/requests/RequestsListPage.tsx`(布局)
- `ui-v4/src/types/ws.ts`(改 type-only re-export)
- `ui-v4/src/stores/live-store.ts`(reducer 合并 attempt_failed/feature_applied)
- `src/start.ts`(connected 工厂改统一 builder)
- `src/lib/observability/sinks/ws.ts`(requestPayload 补 requestBodySize/multiplier + 类型收窄)
- `src/lib/ws/broadcast.ts`(notifyActiveRequestChanged 入参类型收窄)

删除(先提交再删,保历史):
- `ui-v4/src/components/requests/LiveLane.tsx`
- `RequestRow` 的 `LiveRow` / `LiveRowInfo` / `live` prop 死分支([:36-40,57-82,184-191](../../ui-v4/src/components/requests/RequestRow.tsx#L36-L40))——LiveDock 用新 `LiveGroup` 行后成孤儿。

## 8. 验收标准

功能:
- [ ] idle 态:底部一条纤细空闲条;History 占满区域高度。
- [ ] 有在途:折叠条显 `N in-flight · streaming · retrying · oldest`(oldest 每秒滴答)。
- [ ] 从 idle→有在途→回 idle,History 高度**不跳变**(DockBar 恒高)。
- [ ] 点击展开:向上叠加浮层,按 resolved model 分组;N=1 退化扁平。
- [ ] 明细行显 §6 全部富字段;client→resolved 差异可见;活跃重试显 next/wait。
- [ ] 点明细行跳详情页;`Escape` 收起;展开态持久化。
- [ ] WS 重连后已在飞行的请求,富列**立即非空**(connected 补齐)。

数据/类型:
- [ ] `connected.activeRequests[i]` 与 `active_request_changed.request` **逐字段同构**(同一 builder)。
- [ ] `attempt_failed`/`feature_applied` 的富字段被 reducer 合并、UI 可见,不再丢弃。
- [ ] 前端 wire 类型全部 `import type` 自 `~backend/*`,无手维护副本。

## 9. 测试 / 验证

- **bun 单测**:`live-summary` 聚合(count/streaming/retrying/oldest/分组/小 N 退化/分组键回退);`applyActiveEvent` 对 attempt_failed/feature_applied 合并 + terminal 移除(扩 [live-store.bun.test.ts](../../ui-v4/tests/live-store.bun.test.ts))。
- **vitest/jsdom**:折叠摘要文本 / 展开出组头+明细 / idle 态 / 点击导航 / Escape 收起 / reducer 驱动的 retry 展示。滴答用 `vi.useFakeTimers()`,注意与 [HistoryList flash timer](../../ui-v4/src/components/requests/HistoryList.tsx#L242-L249) 隔离避免 flaky。
- **布局不变量测不了**:jsdom 无 layout([RequestsListPage.vitest](../../ui-v4/tests/RequestsListPage.vitest.test.tsx) 把 Virtuoso 换同步 fake、`getBoundingClientRect` 全零)→ 「叠加不推挤 / 遮挡」只能浏览器人工核(no-auto-server,用户启动)。
- **构建 gate 必跑 `bun run build:ui-v4`**(vite/rollup)——**不是** `build:ui`(那是旧 Vue `ui/`)。typecheck + vitest 对「type-only re-export 误拖后端运行时」**双假绿**,唯有 vite build 暴露。配合 `bun run typecheck` / `lint:all` / `bun test`。

## 10. 未采纳 / 记录(record-not-adopted)

- **顶部停靠 / 右下角悬浮胶囊**:用户选底部停靠向上展开。
- **完全隐藏 idle 态**:用户选保留纤细空闲条(可观测性)。
- **紧凑行 + 逐条再展开 / 分组前置汇总两段式**:用户选分组汇总 + 明细(本 spec 采用分组内联明细的统一形态)。
- **重试信息仅由 attemptCount 推导**:用户选完整纳入实时重试遥测(§5.3)。
- **把 wire 类型放 activity-summary.ts**:评审否决(拖 `~/lib/state`);改纯 types-only 模块。
- **重调 summarizeRequestContext 作 builder**:评审否决(拿不到 method/path/model/multiplier);改复用 `requestPayload ∘ snapshotWithSummary`。

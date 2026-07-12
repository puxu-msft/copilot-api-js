# Phase 1 Kickoff：路由骨架 + 二维门控切换

> self-contained kickoff。假设你零项目上下文。先读【必读】再动手。**Phase 0 已 landed（decideRoute→router 自由函数已在 master）**，本 phase 建其上。

## 背景与为什么
copilot-api-js 正建通用「入站格式 × 出站协议腿」翻译矩阵。Phase 0 已把路由决策拆成 `src/lib/pipeline/router.ts` 的 `decideRoute(env)` 自由函数（纯搬迁、golden 锁等价）。**Phase 1 建立全矩阵路由能力的骨架**：后缀解析（`@cc/@responses/@messages`）+ router 全矩阵决策树 + 改写/策略二维门控切换。

**关键：Phase 1 不做任何实际翻译**（翻译在 Phase 2-5）。因此本 phase 的**硬 invariant 是现状零回归**——引入的新决策结构对现状 6 个已通格必须 reduce 回**逐字节相同**的 RouteDecision（Phase 0 的 golden 仍全过）。翻译腿此时还不存在，anthropic-direct 恒走 `/v1/messages`，故二维门控翻转（`clientFormat==="anthropic"` ⟺ `targetEndpoint==="/v1/messages"`）逐字节等价。

## 必读
- [RFC](../../rfc/2026-07-11-anthropic-via-openai-translation.md) **§3.1（二维门控轴）、§4.2（router+RouteInput）、§4.3（全矩阵决策树）、§5（配置解析）、§7.1（改写/策略二维门控+registry 全格式装配）**。
- [master plan Phase 1](../plan.md#phase-1路由骨架--二维门控切换)（T1.1-T1.6 + factory 锚点）+ Phase 0 实施记录（RouteInput 推迟到本 phase 引入）。
- [prompts/README](README.md) 通用红线（golden 预捕获 + commit invariant + 细粒度提交 + 二维门控）。
- skill `large-refactor`（golden-fixture 预捕获 / commit invariants）、`ghc-anthropic-upstream`（thinking signature 硬约束——本 phase 不碰但决定 §9 红线）。

## 目标
建立全矩阵路由骨架，**现状 6 格零回归**：
1. `resolveModelTarget` 解析 `@cc/@responses/@messages` 后缀（穿递归剥离）。
2. router 决策树扩为全矩阵（RouteInput + 每入站序 + force-fallback 按 targetEndpoint 拦截 + 严格 gate）。
3. 改写/策略 appliesTo 从 clientFormat 轴切到 targetEndpoint 轴 + registry 全格式装配。
4. web_search 前置步先 router 决策 + reject 经 ctx。
5. 可观测性：routeOverride + 出站腿 + 翻译腿 format 标签落库。

## Task（每个一 commit，每 commit 后 Phase 0 golden 全过 + 新增单测过 + 全套件绿）

### T1.1 resolveModelTarget 后缀解析（FAIL-1 + W-c）
- `src/lib/models/resolver.ts`：新增 `resolveModelTarget(model): { name, routeOverride }`。后缀枚举 **3 值 `{cc, responses, messages}`**（大小写不敏感）。
- **剥离穿递归**：`resolveOverrideTarget`（[resolver.ts:218](../../../src/lib/models/resolver.ts#L218)）每环 deref、进 `modelIds.has` 校验**前**剥 `@<route>`，routeOverride 随返回值回传；modifier 重挂路径（[:187-188](../../../src/lib/models/resolver.ts#L187) `resolvedBase + suffix`）拿到的 base 已 stripped（否则 `@cc` 埋中间击穿）。
- **双层**：`resolveModelTarget` 入口先剥顶层后缀一次（覆盖无 override 的客户端直发 `resolveModelNameCore` 路径），递归内每环再剥。
- `resolveModelName(model) = resolveModelTarget(model).name` 薄封装 → 13 处现有调用方零改动。
- 单测：modifier+`@cc`、override 链多环、客户端直发、`@messages`、`@xxx` 不识别（保留原样）。

### T1.2 routeOverride 数据通路（W-b）
- `RequestEnvelope` / `RawHttpRequest.preResolved` 加 `routeOverride?: "cc"|"responses"|"messages"`。
- 各 route（messages/cc/responses/gemini）调 `resolveModelTarget` 拿 `{name, routeOverride}`，经 `preResolved` 线程化进 parse → envelope → driver S2。

### T1.3 router 全矩阵决策树 + RouteInput（FAIL-Google-2 + W-priority + FAIL-3 + W4）
- 引入 RFC §4.2 的 `RouteInput { clientFormat, modelName, routeOverride, model }`（Phase 0 记录推迟至此的解耦；router 从 env 提取成窄输入）。
- 决策树照 **RFC §4.3**：① 解析候选 targetEndpoint（显式后缀 isEndpointSupported→指定腿/reject；无后缀→入站默认腿 or 每入站 W-priority 序）② **force-fallback 移 targetEndpoint 解析后统一拦截**（`shouldForceChatCompletionsFallback` [fallback.ts](../../../src/routes/responses/fallback.ts)，覆盖显式 @responses）③ kind = (targetEndpoint==入站默认腿 ? passthrough : translate)。
- **每入站无后缀序**（reduce 回现状，见 RFC §4.3）：cc=cc>responses、responses=responses>cc(force)、gemini=cc>responses、anthropic=messages>cc>responses。
- **invariant 硬 gate**：Phase 0 golden（现状 6 格 RouteDecision）**逐字节仍全过**——新决策树对现状场景必须 reduce 回相同结果。新增单测覆盖全矩阵新决策路径（@messages、每入站翻译序、force-fallback 各入站命中）。

### T1.4 改写/策略 registry 全格式装配 + 二维门控（FAIL-R + FAIL-P）
- **registry 全格式装配**：现状改写是 per-route 单格式注入（`BUILTIN_*_REWRITES=[]` [rewrite-registry.ts:144/187](../../../src/lib/pipeline/rewrite-registry.ts#L144)）。改为 driver S3/S5 从 `{targetEndpoint→改写册}` 全格式表 assemble。
- **appliesTo 轴切换**：6 个 Anthropic 改写 `clientFormat==="anthropic"`→`targetEndpoint==="/v1/messages"`（[request-rewrite-adapter.ts:60](../../../src/lib/codec/anthropic/request-rewrite-adapter.ts#L60)、[response-rewrite-adapters.ts:96](../../../src/lib/codec/anthropic/response-rewrite-adapters.ts#L96) `ANTHROPIC`，5 处 appliesTo）；CC 改写册 appliesTo 扩 `targetEndpoint∈{cc,responses}`。
- **invariant**：Phase 1 期间翻译腿不存在，anthropic-direct 恒 `targetEndpoint==="/v1/messages"`，两轴恒同真 → 改写触发逐字节等价。golden + 现状改写单测全过。
- **T1.4b 策略供料**（WARN-1）：driver 按 targetEndpoint 装配 strategies；Anthropic strategy 的 `resanitize`/`betaProbe` 供料由共享 registry 提供格式专属 builder（[handler-v4.ts:340](../../../src/routes/messages/handler-v4.ts#L340) `buildAnthropicStrategies`），不依赖 route 自有 codec（为 Phase 5 反向腿铺路，但 Phase 1 只需现状腿等价）。

### T1.5 web_search 前置步（FAIL-2 + W-d）
- [handler-v4.ts:225](../../../src/routes/messages/handler-v4.ts#L225) web_search 前置步：先调 router.decideRoute，仅 `kind==="passthrough"` 进双跳；reject **先建 ctx 经 driver 产出**（不裸 throw，否则 ctx-less 无 history）。
- invariant：现状 web_search（anthropic-direct + web_search）行为不变。

### T1.6 可观测性落库（WARN-2 + W6 + W-reject-obs + N-sampleRequest）
- history `model{}` 记 **routeOverride + 实际出站腿** + **翻译腿 format 标签**（镜像 openai-gemini `ENDPOINT_TYPE`，区分翻译 vs direct）+ reject 经 ctx 有记录 + **sampleRequest 按 targetEndpoint**。richest-data-flow（后端完整存）。
- invariant：现状 direct 请求的 history 记录不回归（新字段对 direct 是默认/direct 标签）。

## 验收 gate
- 每 commit：`bun run typecheck` 绿 + `bun test` 全套件通过（Phase 0 那个预存在 UI 404 除外）+ **Phase 0 golden 逐字节全过**（现状零回归硬 gate）。
- 新增单测：resolveModelTarget 双层剥离、router 全矩阵决策树各路径、二维门控每腿 fire 正确册。
- 连跑 golden 3× 确定性。

## 提交指引
`git commit -F <msgfile> -- <精确路径>`，conventional commits（feat/refactor/test），无模型署名。每 task 一 commit（T1.4/T1.4b 可拆）。

## 红线（见 [README 通用红线](README.md)）
- **现状零回归是本 phase 最高优先**——任何 Phase 0 golden 差异都是回归，不是「改进」。
- 二维门控切换、registry 装配是机制改动，改前先跑现状改写单测锁定，改后须仍过。
- **不引入实际翻译**（translateOut/renderResponse 保持现状 identity/passthrough；翻译是 Phase 2+）——若发现某 task 需要翻译才能完成，说明 task 边界错了，停下报告。
- no-auto-server；empirical-verification（typecheck 报错读实际代码定根因）。

## 若撞硬阻塞
Phase 1 引入 RouteInput + registry 全格式装配是较大机制改动。若发现：① 某 codec 的现状 decideRoute 逻辑无法在新决策树里 reduce 回相同（golden 破）② registry 全格式装配破坏了某个现状改写的触发 ③ 二维门控轴切换对某非-anthropic 现状路径有意外影响——**停下报告**，附具体 golden diff / 失败测试，别自行改设计或放宽 golden。

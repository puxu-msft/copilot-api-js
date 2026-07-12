# Phase 0 Kickoff：FormatCodec 纯化（decideRoute → router 自由函数）

> self-contained kickoff。假设你零项目上下文。先读【必读】再动手。

## 背景与为什么
copilot-api-js 要建通用「入站格式 × 出站协议腿」翻译矩阵（让任意客户端 SDK 用任意 GitHub Copilot 模型）。前置架构重构：把路由决策 `decideRoute` 从 `FormatCodec` 拆到独立 router，使 codec 成为**纯格式翻译器**（不读上游模型能力）。这是纯重构、**行为逐字节等价**，为后续翻译特性铺地基。

为什么先做：现状 `FormatCodec.decideRoute` 让 codec 知道 upstream（读 `supported_endpoints`/vendor），违反「codec 只翻译」。拆出 router 后，路由/reject 决策单一真相源，翻译矩阵才能干净地按 (clientFormat × targetEndpoint) 二维组织。

## 必读
- [RFC §3/§4](../../rfc/2026-07-11-anthropic-via-openai-translation.md)（架构 + 接口契约）+ ADR [decideRoute 拆分](../../decisions/2026-07-11-route-decision-separated-from-format-codec.md)。
- [master plan Phase 0](../plan.md)（本 phase 的 task + factory 锚点）。
- [prompts/README](README.md) 通用红线（**尤其 golden 预捕获 + commit invariant + 细粒度提交**）。
- skill `large-refactor`（§4 golden-fixture 预捕获、§2 commit invariants）。

## 目标
`decideRoute` 从 5 个 codec 拆到新 `src/lib/pipeline/router.ts` 的 `decideRoute(RouteInput): RouteDecision` 自由函数；`FormatCodec` 接口去 `decideRoute`。**每 commit 行为逐字节等价**。

## 改动锚点（factory 表）
| 现状 | 位置 | 去向 |
|---|---|---|
| `FormatCodec.decideRoute` 接口 | [types.ts:619](../../../src/lib/pipeline/types.ts#L619) | 删（T0.5）|
| driver 调用点 ×2 | [driver.ts:144](../../../src/lib/pipeline/driver.ts#L144)(runRequest) + :202(inspectRequest) | 改 `router.decideRoute` |
| anthropic decideRoute | codec/anthropic/codec.ts（`supportsDirectAnthropicApi` [features.ts:38](../../../src/lib/anthropic/features.ts#L38)）| 搬 router（T0.1）|
| cc decideRoute | `decideOpenAiCcRoute` [openai-cc/codec.ts:354](../../../src/lib/codec/openai-cc/codec.ts#L354) | 搬 router（T0.2）|
| responses decideRoute | `decideOpenAiResponsesRoute` [openai-responses/codec.ts:382](../../../src/lib/codec/openai-responses/codec.ts#L382)（含 Google force）| 搬 router（T0.3）|
| gemini decideRoute | [openai-gemini/codec.ts:157](../../../src/lib/codec/openai-gemini/codec.ts#L157)（委托 cc）| 搬 router（T0.4）|
| dry-run 消费点 | routes/debug/dry-run-pipeline.ts | 同步（T0.5）|

**已核实前提**：5 个 decideRoute 均对 codec 闭包状态纯（只读 `env.model`），可无损搬进无状态 router。

## TDD 步骤（每 Task 一 commit）
1. **T0.0 golden 预捕获（改动前，最关键）**：写 `tests/pipeline/router-golden.it.test.ts`，对 4 端点 × 全场景断言 `RouteDecision`：每 vendor 的 passthrough/translate/reject + **Google force-fallback**（responses 入站 + Google 模型→CC）+ @后缀（若现状支持）。**在当前 HEAD（未改动）上跑通** = 锁定现状行为。commit：`test: golden-capture decideRoute across 4 endpoints before router extraction`。
2. **T0.1 建 router + 过渡桥（关键：守全套件绿）**：
   - driver 是 **`deps.codec.decideRoute(parsed)` 单调用点**（[driver.ts:144](../../../src/lib/pipeline/driver.ts#L144)），每个 route 注入自己的 codec。**一旦切成 `router.decideRoute`，全部 4 格式的 route 都会走 router**（同一行代码）。所以 router 必须在 T0.1 就**按 `clientFormat` 分派**：
     - `clientFormat==="anthropic"` → 新搬的 anthropic 逻辑（`supportsDirectAnthropicApi`）。
     - **其余（cc/responses/gemini）→ 过渡桥：委托回各 codec 仍存活的 `decideRoute`**（`env.codec.decideRoute(env)` 或经 deps 传入的 codec map；T0.2-T0.4 逐格搬迁后移除对应桥）。
   - 因此 **anthropic codec 的 decideRoute（[codec.ts:218](../../../src/lib/codec/anthropic/codec.ts#L218)）此时可留 dead，但 cc/responses/gemini 的 decideRoute 必须保持 live**（被过渡桥调用）直到各自 T0.2/T0.3/T0.4 搬迁。
   - 验收：**T0.1 commit 后全 4 格 golden 都过**（anthropic 走新逻辑、其余走桥，行为逐字节等价）——「golden anthropic 格过」指该 commit 的**新增权威覆盖点**，绝非放行其余格回归。commit。
3. **T0.2/T0.3/T0.4** 逐个把 cc/responses(含 Google force)/gemini 的 decideRoute 逻辑搬进 router、移除对应过渡桥。每个 commit 后**对应格 + 全套件** golden 过。
4. **T0.5** 删接口方法（[types.ts:626](../../../src/lib/pipeline/types.ts#L626)）+ 5 codec 实现 + inspectRequest([:202](../../../src/lib/pipeline/driver.ts#L202)) + dry-run 同步。此时过渡桥已全移除。`bun run typecheck` 绿 = 无残留调用。golden 全过。commit。

## 验收 gate
- 每 commit：`bun run typecheck` + `bun test tests/pipeline/` + golden T0.0 全过。
- 最终：golden 逐字节等价（连跑 3× 确定性）；`grep -rn "decideRoute" src/lib/codec/` 零残留（除 router）。
- **byte-critical**：这是纯重构，golden 等价是硬 gate——任何 RouteDecision 差异都是回归。

## 提交指引
`git commit -F <msgfile> -- src/lib/pipeline/router.ts src/lib/pipeline/driver.ts <每次精确路径>`。conventional commits（refactor/test），无模型署名。

## 红线
见 [prompts/README 通用红线](README.md#通用红线各-phase-引用不重复)。**本 phase 重点**：golden 预捕获必须在改动前 HEAD 跑通（否则等于编码新行为、证明不了等价）；每 commit 终态可编译 + golden 过，绝不叠多个搬迁再 debug 一堵墙类型错误。

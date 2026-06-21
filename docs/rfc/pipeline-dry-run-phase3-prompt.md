# Phase 3 kick-off prompt — dry-run inspector 全格式 + skipRender + frameActions + prepare-wire

> Self-contained 启动 prompt（可冷接手）。设计稿见 `docs/rfc/pipeline-dry-run-inspector.md`（已两轮对抗评审，§10 保真边界 / §11 实现约束必读）。Phase 1（响应侧 Anthropic）+ Phase 2（请求侧 Anthropic）已落地。

## 你要做什么

把 `POST /api/debug/dry-run-pipeline`（`src/routes/debug/dry-run-pipeline.ts`）从 **Anthropic-only** 扩到**全格式**，并补两个被 Phase 1/2 推迟的能力：`skipRender`（非 identity render 的格式才需要）+ per-rewrite `frameActions` hook + `prepare-wire`（S4-pre）请求侧档。

裁判轴：**长远正确 + 完整**，守 YAGNI（评审 C5 已证 CC/Gemini 响应侧改写为空集——别为不存在的消费者编投机测试）。Bun 项目（`bun test`，不是 npm）。

## 已落地的基础（直接复用，别重造）

- **driver `inspectRequest(raw, stopAfter)`**（`src/lib/pipeline/driver.ts`，types.ts:310 接口 + `RequestInspectStage`/`RequestInspection`）：跑 S1→stopAfter（parse/translate/rewrite-in）、不进 S4、逐阶段 `structuredClone` 快照 + S3 per-rewrite `{name,changed}`。**格式无关**（用 `deps.codec` + `deps.requestRewrites`）——Phase 3 只需按 format 传对的 codec/rewrites。
- **`withCapturingManager(fn)`**（`src/lib/context/manager.ts`）：无副作用临时换全局 manager（不污染 history/WS、还原不停生产 reaper）。请求侧任何格式都复用它包住 `codec.parse`。
- **endpoint 现状**：响应侧（Anthropic 手工 env + `ANTHROPIC_RESPONSE_REWRITES` + 捕获 ctx）；请求侧（真实 `createAnthropicCodec` + `preprocessAnthropicMessages` + throwaway betaProbe + `inspectRequest`）。

## Phase 3 任务（按依赖序）

### T1 — `RunResponseOpts.skipRender`（driver，仅非 identity render 格式需要）
- **背景**：Anthropic `renderResponse` 是 identity，故 Phase 1 不需要它（rewrite-out == render）。但 CC-via-responses fallback / Responses 的 render 非 identity，要看 render 前的 S5 帧就需要 skipRender。
- **改 `src/lib/pipeline/driver.ts` `runResponse`**：在 `RunResponseOpts` 加 `skipRender?: boolean`。两个 render yield 点**都要分叉**（评审 §11、driver.ts 现 :305 内层 `yield* renderFrames` + flushChain 后的 render yield 点）：`skipRender` 时 `yield frame`（UpstreamFrame，与 ClientFrame 同型 `SseFrame`）而非 `yield* renderFrames(...)`。**注意 finally 的 flushChain 路径同样要覆盖**（否则丢流末 buffered 帧）。`onUpstreamFrame` 在 render 前、loop 顶（driver.ts:300），skipRender 不影响它。
- **测试**：用一个 render 非 identity 的 mock codec，断言 skipRender 拿到 render 前帧、不 skip 拿到 render 后帧；含 flushChain（buffering rewrite）的流末帧。

### T2 — per-rewrite `frameActions` hook（driver）
- **采样点**：`passThrough`（driver.ts:~424）内 `rewrites[i].transform(frame, states[i])` 返回的 `FrameAction`（`emit`/`suppress`/`buffer`，rewrite-registry.ts:76）。
- 加可选 `RunResponseOpts.onRewriteAction?(rewriteName, frameIndex, action)`，dry-run 传它采样；生产路径不传 → 零开销。
- endpoint 响应侧把采样结果填进输出 `stages["rewrite-out"].perRewrite[].frameActions`（RFC §3 输出 schema）。
- **测试**：断言 decode rewrite 在 buffer 帧时报 `buffer`、stop 时报 `emit`；filter 报 `suppress`。

### T3 — 全格式 driver 组装（endpoint，OQ2 已定：dry-run 自带 switch）
- **不抽** `buildDriverDeps` 共享工厂、**不迁**真实路由（评审 C6：deps 强 per-request 闭包）。endpoint 内按 `format` switch 选 codec 工厂 + responseRewrites 数组。
- **响应侧 rewrites 按格式**（评审 C5 实证）：Anthropic=`ANTHROPIC_RESPONSE_REWRITES`(4)、Responses=`RESPONSES_RESPONSE_REWRITES`(1 fixIds)、**CC/Gemini=空**（`createPipelineDriver` 不传 responseRewrites）。CC/Gemini 响应侧标 `rewritesAvailable: false`，**别编空改写测试**。
- **请求侧**：每格式真实 codec 组装（CC/Gemini/Responses 各自的 `create*Codec` + per-request 闭包数据）。Gemini codec 工厂内委托内部 openai-cc codec（见 DESIGN）。
- **保真边界（§10，必须在 `fidelity.caveats` 逐格式标）**：Gemini render 出 **CC 帧非 Gemini**（整流翻译 `translateOpenAIStreamToGemini` 在 driver 外，gemini/handler-v4.ts:237）；Responses 缺 post-render tool-name restore（responses/handler-v4.ts:200/256）；Anthropic 缺 heartbeat。
- **测试数据约束**：live DB 当前 100% anthropic+stream，非流式/其他格式回放**无 live entry**，须用 fixture（评审 §11）。

### T4 — `prepare-wire`（S4-pre，请求侧）
- **prepareWire 非纯**（评审 §11 H2）：`prepareAnthropicWire`（codec.ts:383 `betaProbe.recordOutbound` + :389 `ctx.recordFeature`）。dry-run 须用 **throwaway betaProbe**（已在请求侧这么做）+ 捕获 ctx。
- inspectRequest 加 `prepare-wire` stopAfter：rewrite-in 后调一次 `codec.prepareWire(env)`（**只首个 attempt**，反应式 retry strip 不可见——输出标 `note: "first-attempt only"`，评审 §11 P1）。
- 输出 `stages["prepare-wire"] = { wire, headers, note }`。

## 验收 / 验证
- 每 T 独立绿 + 提交（一增量一 commit，conventional commits，无 Claude 署名）。
- `bun run typecheck` 绿；`npx eslint` 改动文件零错；`bun test tests/infra/debug-dry-run-pipeline.http.test.ts tests/pipeline/*.unit.test.ts` 绿。
- 每格式 http 测试（请求侧用 fixture payload；响应侧 Anthropic/Responses 验改写、CC/Gemini 验 render + `rewritesAvailable:false`）。
- 收尾：RFC §8 标 Phase 3 done；DESIGN 路由表更新（全格式 + 请求/响应侧）；deferred-items 记"配置经 env 注入消竞态"重构（§6 仍 deferred）。
- subagent 对抗 review（显式裁判轴：长远正确+完整，非 ROI/YAGNI；绝对断言读 file:line 核验）。

## 红线 / 易错
- 别用 temp **state-swap** 做 configOverrides（评审 C1：窗口=整流时长、污染并发真实请求）——MVP 不做 configOverrides，env-注入重构留 deferred。
- 别用 `resetRequestContextManagerForTests` 做 manager-swap（它 `stopReaper()` 生产 reaper）——用 `withCapturingManager`。
- CC/Gemini 响应侧空改写**别假装已覆盖**——`rewritesAvailable:false` 诚实标注。
- skipRender **必须覆盖 flushChain 路径**，否则丢流末 buffered 帧。

# RFC: 流水线 dry-run / inspector endpoint

状态：草案 v2（已纳入第一轮 3 人对抗评审）。会话：2026-06-21。

动机：AskUserQuestion `questions`-as-string 调查中，真实失败 entry 被 reaper 淘汰、现象间歇、无法按需复现，诊断耗 25+ 探针。需要一个能**喂合成/回放的请求上下文 + 上游响应、走真实 v4 流水线、在任意阶段中止并输出中间态**的离线 endpoint，把"等自然复现"变成"确定性回放与逐阶段观测"。

> **v2 变更（据评审）**：MVP 砸掉 `configOverrides`（state-swap 窗口=整条流时长、会长时间污染并发真实请求，且回放本就该用 live 配置——投机表面）。新增 §10「保真度边界」。ctx 隔离由"stub ctx"（不可行：codec.parse 硬调全局 manager）改为请求侧 manager-swap / 响应侧手工 env。`logs` 不靠全局 consola 拦截，改用结构化 feature 事件。

## 1. 目标与非目标

**目标**：
- 离线（短路 GHC）跑真实 v4 流水线任意前缀，输出选定阶段中间结果。
- 覆盖请求侧（S1 parse / S2 translate / S3 rewrite-in / S4-pre prepare-wire）与响应侧（S5 rewrite-out / S6 render）。
- 全格式（anthropic / openai-cc / openai-responses / openai-gemini）——但响应侧改写**仅 Anthropic(4 条)+Responses(1 条)非空**，CC/Gemini 为空集（见 §10、C5）。
- 双输入：`entryId` 回放 stored entry / inline 合成。
- 输出最丰富可观测数据（中间态 + per-rewrite 逐帧动作 + 结构化 feature/pipeline 诊断 + raw/forwarded diff）。

**非目标**：
- 不真打 GHC（S4 用提供/回放上游短路；不仿真重试/速率限制——故反应式 retry 改写不可见，见 §10）。
- 不持久化 history、不污染真实 observability sink（隔离见 §7）。
- **不做 per-request `configOverrides`**（MVP 砸掉，见 §6）。
- 不是性能工具。

## 2. 阶段模型（对齐 DESIGN 七阶段，含保真注脚）

| stopAfter | 阶段 | 输出 | 需要输入 | 保真注脚 |
|---|---|---|---|---|
| `parse` | S1 | `RequestEnvelope`（model 解析、body 提取） | request | 高保真 |
| `translate` | S2 | route 决策 + translateOut 后请求 | request | 高保真 |
| `rewrite-in` | S3 | 请求改写链结果 + per-rewrite `{name, changed}` | request | `stats` 多数 rewrite 不填（走 ctx 侧信道，见 P2/§3）；Anthropic 当前仅 1 条 sanitize rewrite |
| `prepare-wire` | S4-pre | `codec.prepareWire` 产出的 wire payload + headers（不发送） | request | **仅首个 attempt 的 wire**——反应式 retry 改写（beta-strip / server-tool-strip）不可见（C/P1） |
| `rewrite-out` | S5 | 响应改写链逐帧结果 + per-rewrite 逐帧 `{frameIndex, action: emit/suppress/buffer}` + 流末 flushChain | request + 合成上游 | **driver 输出 ≠ 客户端实收**（缺 handler-side 后处理，见 §10） |
| `render` | S6 | 翻回客户端协议后的 forwarded | request + 合成上游 | 同上 + Gemini render 出 CC 非 Gemini（§10） |

S4 exchange 恒被合成上游替换。请求侧 stopAfter ≤ prepare-wire 无需上游；响应侧 ≥ rewrite-out 必需。

## 3. Endpoint

`POST /api/debug/dry-run-pipeline`（与 `dry-run-truncate` 并列于 `src/routes/debug/route.ts`）。

**输入（zod）**：
```
{
  // 输入源（二选一）
  entryId?: string     // 回放：inboundRequest+httpHeaders.inboundRequest 作请求；
                       //   响应侧用 top-level sseEvents[].raw(流式) / outboundResponse(非流式) 作上游
  request?: object     // inline 请求 payload（format-native）
  upstream?: { sseEvents: Array<string|{raw:string}> } | { response: object }  // inline 合成上游（响应侧才需）
  // 控制
  format?: "anthropic"|"openai-cc"|"openai-responses"|"openai-gemini"  // entryId 时从 endpoint 推导(见映射表)
  stream?: boolean
  stopAfter: "parse"|"translate"|"rewrite-in"|"prepare-wire"|"rewrite-out"|"render"
}
```
（**无 `configOverrides`**——dry-run 一律用当前 live 配置。）

**输出**：
```
{
  stopAfter, format, stream,
  fidelity: { clientFinal: boolean, caveats: string[] },   // 见 §10，诚实标注本次输出与客户端实收的差异
  stages: {
    parse?, translate?,
    "rewrite-in"?: { env, applied: [{name, changed}] },     // stats 不在此(P2)
    "prepare-wire"?: { wire, headers, note: "first-attempt only" },
    "rewrite-out"?: { rewritesAvailable: boolean, perRewrite: [{name, frameActions:[{frameIndex,action,outputFrameCount}]}], flushed: [...] },
  },
  result: <stopAfter 阶段主输出>,
  diagnostics: {
    features: [{feature, detail}],      // capturingPublisher 收割的 recordFeature(含 tool-input-decode-failed)
    pipelineInfo?: {...},               // ctx.setPipelineInfo 侧信道(sanitize 统计等)
  },
  upstreamRaw?: [...],
}
```

## 4. Driver 阶段 API 新增

现状阻碍：`runRequest`(driver.ts:119) 跑到 S4 才返回（打 GHC）、`runRewriteIn`(driver.ts:149) 私有。故给 `PipelineDriver` 加：

```
inspectRequest(raw, stopAfter): RequestInspection   // 跑 S1→stopAfter，绝不进 S4
```
- 复用 driver 内部 S1-S3 逻辑（codec.parse / decideRoute / translateOut / runRewriteIn），每阶段后快照 env。
- `applied` 从 `RewriteResult.changed`(rewrite-registry.ts:44) + `RequestRewrite.name` 取（**不是** P3.2 未实现的 stats，见 P2）。
- `prepare-wire`：显式只跑首个 attempt 的 `codec.prepareWire(env)`（绕开 runExchange 的重试循环），输出 `note: "first-attempt only; reactive retry rewrites not visible"`（C/P1）。

响应侧复用既有 `runResponse`/`runResponseWhole`，加：
- `RunResponseOpts.skipRender?: boolean`——driver 在 `renderFrames` 处分叉(`yield frame` 而非 `yield* renderFrames`)，**同时覆盖 `flushChain` 的 yield 点**（否则丢流末 buffered 帧，C/P3）。
- per-rewrite 逐帧动作：`runResponse` 已逐帧调 rewrite；加一个可选 `onRewriteAction?(name, frameIndex, action)` hook 供 dry-run 采样（不污染生产路径）。

## 5. Per-format driver 组装（OQ2 已定：dry-run 自带 switch）

评审 C6 实证：4 格式 deps 全依赖 per-request 闭包（betaProbe/preprocessInfo/strategies 工厂/codec.getRequestRewrites()），**不可纯 `(format)=>deps` 静态抽取**。故：
- dry-run 内按 format `switch` 选 codec 工厂 + responseRewrites 数组（约 4 行），strategies 用空/no-op（S4 短路无需重试）、transport 用 no-op。
- **不**抽 `buildDriverDeps` 共享工厂、**不**迁真实路由（强抽会因 per-request 参数膨胀劣于现状，违 YAGNI）。

## 6. 配置覆盖（MVP 砸掉）

评审 C1 实证：rewrites 逐帧读 module-global `state`（`thinkingRewrite` 无 createState、transform 每帧读 `state.thinkingSignatureCompat`；`appliesTo`/`prepareWire` 每次读 global）。temp state-swap 窗口=**整条响应流时长**（opus 长 thinking 数十秒~数百秒），会长时间污染并发真实请求配置。且回放本就该用 live 配置（配置已是 live、无需改）——`configOverrides` 是投机表面（违 architecture-health-first 末句）。

**故 MVP 不做 configOverrides，dry-run 一律 live 配置。**

> **暂缓项（完整文档化供日后决策）**：若日后需"按不同配置对比回放"，正确形态是**配置经 env/deps 注入、rewrites 读快照而非 module-global `state`**（彻底消竞态）。这是跨所有 rewrite 的重构，记 deferred-items。**绝不**用 temp state-swap 绕（已证窗口=整流时长、live 污染）。

## 7. 隔离（无 stub ctx）

评审 C2/C3 实证：`codec.parse`(S1) 内部硬调 module-global `getRequestContextManager().create()`（无 ctx 注入口），`manager.create()` 无条件发 `request.created` → in-flight 映射 + WS 推送（污染 UI/in-flight；非 SQLite，但仍污染）。consola 是进程单例、已被 `installConsolaRepublish` 全局 hijack，dry-run 再拦截会吞并发请求日志。

**方案（分请求侧/响应侧）**：
- **响应侧（S5）**：dry-run **手工构造 env**（注入捕获型 ctx，不跑 codec.parse）→ **零全局 swap、零污染**。ctx 用最小捕获实现（`recordFeature`/`setPipelineInfo` 收进本地、`toolNameMapper`、driver 用的 `beginAttempt/transition/...` no-op）。**注**：必须列全 rewrites+driver 调用的 ctx 方法（评审给了清单），漏一个 transform/driver 即抛——实现期对照清单。
- **请求侧（S1-S3，需跑 codec.parse）**：临时替换 module-global `_manager` 为带 capturingPublisher 的实例（事件收本地、不进真实 bus），**模块级 mutex 串行化 + try/finally 还原**，文档告警"勿在重流量期跑（替换期并发真实请求的 request.* 事件丢失）"。这是 MVP 唯一的全局 swap（state-swap 已砍）。
- **`diagnostics.logs` 砍掉**（C3：全局 consola 拦截会吞生产日志 + 无法 per-request 归属）。诊断改用 **capturingPublisher 收割的结构化 feature/pipelineInfo 事件**（`tool-input-decode-failed`/`tool-call-recovered`/sanitize 统计等）——per-ctx、零全局污染、比日志字符串更丰富（对齐 richest-data-flow）。

## 8. 分阶段实现

- **Phase 1（响应侧 Anthropic，零全局 swap，最高价值最低风险）**：手工 env + 捕获 ctx + `skipRender` + per-rewrite frameActions hook + entryId(sseEvents/outboundResponse 回放)/inline 上游 + stopAfter rewrite-out/render。直接复现本次调查场景。http 测试。
- **Phase 2（请求侧 Anthropic）**：driver `inspectRequest` + manager-swap 隔离(mutex) + stopAfter parse/translate/rewrite-in/prepare-wire(首 attempt) + entryId header 从 httpHeaders.inboundRequest 合成 RawHttpRequest。
- **Phase 3（全格式）**：format switch 接 openai-cc/responses/gemini；响应侧对 CC/Gemini 标 `rewritesAvailable:false`（不编空改写测试）；Gemini render 标保真注脚（输出 CC）。每格式请求侧 + 高保真处的测试。
- **收尾**：§10 保真边界 + DESIGN 路由表 + 模块文档；deferred-items 记"配置 env 注入"重构。

## 9. 决策（评审后）

1. **[已定]** Driver introspection API（inspectRequest + skipRender）——采纳。
2. **[已定，OQ2]** dry-run 自带 switch、不抽 buildDriverDeps、不迁真实路由（C6）。
3. **[已定]** MVP 砸掉 configOverrides（C1）；env-注入重构记 deferred。
4. **[已定]** 全格式（用户定）——但响应侧 CC/Gemini 空集显式标注（C5）。
5. **[已定]** 必须补 §10 保真边界（C4）。
6. endpoint 命名 `/api/debug/dry-run-pipeline`。

## 10. 保真度边界（C4，必读）

dry-run 跑 driver，但**大量 client-facing 处理在 driver 之外、handler-side**，故 `result` 不等于客户端真实实收。逐格式：

| 格式 | driver 输出 vs 客户端实收的差异 | file:line |
|---|---|---|
| Anthropic | 缺 **synthetic heartbeat 注入**（handler-side `startForwardedSseHeartbeat`） | messages/handler-v4.ts:548 |
| Responses | 缺 **tool-name restore**（post-render，handler-side `restoreResponsesStreamFrameToolNames`/`restoreResponsesOutputToolNames`） | responses/handler-v4.ts:200,256 |
| Gemini | **render 输出是 CC 帧、非 Gemini**——整流翻译 `translateOpenAIStreamToGemini` 在 driver 之外 | gemini/handler-v4.ts:237 |
| 全 | 缺 S4 反应式 retry 改写（beta-strip/server-tool-strip）——dry-run 不发送=无错误=无 strategy | driver.ts:232 |

输出 `fidelity.caveats[]` 逐条回填上述。**本次调查场景（AskUserQuestion decode/backfill）是 driver-side 改写（在 ANTHROPIC_RESPONSE_REWRITES 内），故对本案 driver 输出≈客户端实收（仅差不影响内容的 heartbeat）——恰好够用。** 但 tool-name/Gemini/heartbeat 场景**会误导**，必须靠 `fidelity` 字段警示。

**entryId 回放保真边界**（P4）：
- **配置漂移**：entry 不存当时 `state` 快照；dry-run 用当前 live 配置跑历史 entry，若配置已改则结果 ≠ 当时客户端实收。
- **preprocess 不可重建**：`toolNameMapper`/`preprocessAnthropicMessages` 的 dedup/strip 是 handler pre-step 产物，entry 只存结果 payload；从 inboundRequest 重跑会**重算 preprocess**，逻辑已改则不一致。
- **betaProbe 状态丢失**：反应式 beta 候选是 S4 重试期演化，dry-run 短路拿不到。
- 故 entryId 回放对**响应侧 S5（喂 sseEvents[].raw）高保真**，对**请求侧 S1-S3 是"用当前代码+配置重跑 inboundRequest"而非"复现当时"**。

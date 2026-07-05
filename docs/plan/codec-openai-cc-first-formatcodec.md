# P2.2 — `codec/openai-cc.ts`（首个 FormatCodec 实现）

## Context

v4 管线重构进入 P2：建 driver、逐格式从旧 handler 切到新七阶段管线。P2.1 已落地 driver 骨架（`createPipelineDriver`）+ `FormatCodec` 接口（`src/lib/pipeline/types.ts`，8 方法，**已锁**）。

**本 commit（P2.2）** 新建 `src/lib/codec/openai-cc.ts`，把现状 CC handler 里散落的「该格式与接入/上游」差异收口为一个实现 `FormatCodec` 的 **per-request 工厂**。openai-cc 是「翻译中枢」——Gemini codec（P2.5）将委托它。**本 commit 不接线路由**：旧 `handleChatCompletion` 仍在用（P2.3 才切 driver + feature flag）。invariant 只要求 **codec 单测绿**，不要求行为等价（等价是 P2.3 的 invariant）。

因这是 4 个 codec 中的首个、为后续定调，方案经独立 Plan agent 批判校验，下列决策均证据闭合。

## 关键设计决策（含 spec 偏离与 P2.3 下沉，均已文档化）

1. **per-request 有状态工厂** `createOpenAiCcCodec(deps)`：codec 实例 = 一个请求的编解码会话。闭包持有 per-request 状态（via-responses 的 `createStreamTranslator` 跨帧状态、tool-name mapper、droppedParams 去重标记、include_usage）。FormatCodec 接口无 state 槽，故跨帧状态**只能**在闭包——这是 codec 的设计契约，非 workaround。确立为范式（Responses/Gemini/Anthropic 同形）。

2. **`translateOut` = identity**。CC→Responses 翻译落 **`prepareWire`**（targetEndpoint=`/responses` 时）。
   - **强制原因**：auto-truncate strategy（retry-transport §2.2 表末行）假设 `env.body` 是 **CC 形态**（改 `env.body.messages` 从 CC original 截断），而 strategy 接口 `handle(error, env)` 只拿到 env、够不到 CC-original。若 `translateOut` 在 S2 就翻成 Responses，truncate 会崩。故当前 strategy 契约下，prepareWire 内翻译是唯一可行点。
   - **spec 偏离**：retry-transport §3 把 prepareWire 限为「header+body 裁剪」；完整格式翻译不属裁剪（幂等性仍满足，纯函数同 env 同输出）。在 prepareWire JSDoc **显式记录此偏离 + 强制原因**，并登记 P2.3 遗留「选项 Y：CC→Responses 作为 S3 RequestRewrite，需 strategy 改为持有 CC-original」。

3. **`renderResponse`**：targetEndpoint=`/chat/completions` → identity 逐帧透传；=`/responses` → 闭包 translator 逐帧 `translate(parsedEvent)` 产 CC chunks。必须内化现状 `translateResponsesStream` 的 3 个循环级行为（漏任一则字节不等价或撕流）：
   - `JSON.parse(frame.data)` 包 `try/catch`，失败返回 `[]`（**漏 try/catch 会让异常穿透 driver 的 `async function*` 撕掉整流**，responses-to-cc-stream.ts:144 注释明示要避免）；
   - 上游 `[DONE]` / 空 data → `[]`（吞掉，避免与 P2.3 流末合成双 `[DONE]`）；
   - `response.completed` → 多帧数组 `[finishChunk, usageChunk]`（driver `renderFrames` 展开数组保时序）。

4. **`[DONE]` 流末合成不在 P2.2**（选项 c）。拆出闭包 translator 后逐帧永不产 `[DONE]`（现状 `[DONE]` 在 `translateResponsesStream` 流末、translator 外）。codec JSDoc 记录「via-responses `[DONE]` 由 P2.3 driver 流末合成」，候选实现：一条 S5 terminal ResponseRewrite（`appliesTo: clientFormat==="openai-cc" && targetEndpoint==="/responses"`，`flush()` 产 `[{data:"[DONE]"}]`，复用 driver `flushChain`）。passthrough 的 `[DONE]` 来自上游帧、identity 透传，天然正确，不受影响。

5. **`parse` 同步、不含 system-prompt**。FormatCodec.parse 签名同步，物理上禁止 await；而 `processOpenAIMessages` 是 async（`applyConfigToState` 真 I/O）+ 非幂等。parse 做：resolveModelName + modelIndex.get + azure override（读 `raw.modelOverride`）+ reqBodySize（读 `raw.headers` content-length）+ manager.create + setOriginalRequest + setInboundRequestHeaders + 请求侧 tool-name sanitize（mapper 存闭包+ctx）+ `sanitizeOpenAIMessages` + 建 env。
   - **P2.3 前置（登记遗留）**：system-prompt 注入归宿 = route 在 `codec.parse(raw)` **之前** `await processOpenAIMessages` 改 `raw.body`（保 parse 同步纯）。在 parse JSDoc 写明。

6. **归属边界**（不属 P2.2 codec，登记/留给 P2.3）：truncation marker（route/S5）、forwardedSseEvents 采样（driver，P3.2）、响应侧 tool-name restore（S5 ResponseRewrite）、guardSseIterable（transport, retry-transport §4）、终态 complete/fail/abort 决策（driver S7）。codec 只**提供** `createResponseAccumulator` 工厂与 `formatError` 帧成形，不**驱动**它们。

## 实现

新建 `src/lib/codec/openai-cc.ts`，导出 `createOpenAiCcCodec(deps): FormatCodec`。8 方法复用现有函数：

| 方法 | 实现 | 复用 |
|---|---|---|
| `parse` | 同步建 env（见决策 5）；env.body = sanitized+tool-renamed CC payload | `resolveModelName`、`state.modelIndex`、`manager.create`、`buildChatCompletionsToolNameMapper`/`applyChatCompletionsToolNameSanitization`、`sanitizeOpenAIMessages`、`captureInboundHeaders` |
| `decideRoute` | `isEndpointSupported(CHAT_COMPLETIONS)`→passthrough；elif `isResponsesSupported`→translate `/responses`；else reject 400（复刻 handler.ts:306-307 字串） | `models/endpoint` |
| `translateOut` | identity（返回 env） | — |
| `prepareWire` | `/chat/completions`: `fillMaxCompletionTokens`(O10)+`prepareChatCompletionsRequest`(O8-O9) → PreparedRequest{url,headers,body,stream}；`/responses`: `translateChatCompletionsToResponses`(+droppedParams 去重写 ctx，复刻 some-check)+`normalizeCallIds`(gated `state.normalizeResponsesCallIds`)+`prepareResponsesRequest` | `request-preparation`、`translate`、`responses-conversion` |
| `renderResponse` | 见决策 3 | `createStreamTranslator`（闭包） |
| `renderResponseNonStreaming` | identity（CC）或 `translateResponsesResponseToCC`（Responses） | `translate` |
| `formatError` | `{event:"error", data: JSON.stringify({error:{message, type: streamErrorToOpenAIErrorType(err)}})}` | `stream-error` |
| `createResponseAccumulator` | `createOpenAIStreamAccumulator()` | `stream-accumulator` |

`DriverDeps`/工厂签名确认 deps 可被 Gemini codec 复用（不含 CC-specific 不可共享句柄）。

## 测试（`tests/openai/openai-cc-codec.*.test.ts`，镜像域目录）

- `*.unit.test.ts`（纯方法）：`decideRoute`（passthrough/translate/reject 三分支 × 模型能力矩阵）、`translateOut`=identity、`renderResponse`（**专项**：malformed 帧→`[]`、上游`[DONE]`/空→`[]`、`completed`→双帧、function_call 跨帧累积、include_usage 时序）、`renderResponseNonStreaming`、`formatError`（idle/shutdown/other × 三类型）、`createResponseAccumulator`。
- `prepareWire`：**不纯**（读全局 state+copilotHeaders）→ 用 `state-fixture`/`autoRestoreState` 注入 state；验 `/chat/completions` 与 `/responses` 两分派的 url/headers/body + droppedParams 去重 + normalizeCallIds gating。
- `*.it.test.ts`（`parse` 调 manager.create 需 context runtime）：parse 产出 env 字段（model/stream/body/targetEndpoint 初值）、azure override、tool-name mapper 入 ctx、reqBodySize。

## 文档同步（本 commit 内）

- `docs/v4/03-spec/codec.md` §1：补「codec 实例 per-request 构造、可持有 per-request 状态」范式说明。
- `docs/v4/05-progress.md`：P2.2 打 ✅ + 记录验证；新增 3 条遗留——(P2.2-D1) prepareWire 内翻译偏离 §3 + 选项 Y；(P2.2-D2) via-responses `[DONE]` 流末合成下沉 P2.3；(P2.2-D3) system-prompt 注入须 route 在 parse 前 await 改 raw.body。

## Verification

- `bun run typecheck` 绿；`eslint --fix` 无新增 warning（不用 prettier --write）。
- `bun run test:unit` + 相关 `.it.test` 绿；codec 单测覆盖上列全部 case。
- 全 offline 套件 `bun run test:backend` 绿（无回归——本 commit 纯新增，旧 handler 未动）。
- subagent review 逐项对照 handler.ts 基准行为 + 我亲自复核「renderResponse 3 行为复刻」「prepareWire 翻译/去重」「decideRoute 字串等价」。
- 不接线、不启服务器；codec 不被任何路由消费（grep 确认零路由引用，符合 P2.2「旧 handler 仍在用」）。

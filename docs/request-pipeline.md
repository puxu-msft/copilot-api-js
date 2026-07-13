# 请求管线、重试与限速

v4 管线由 per-request driver 编排七阶段（S1–S7）。重试是错误驱动的 S4 重试环，限速由 transport 内自适应消化。

## 七阶段 driver

`src/lib/pipeline/driver.ts` 实现 S1 parse → S2 route/translate → S3 rewrite-in → S4 exchange（重试环）→ S5 rewrite-out → S6 render → S7 forward，并在阶段边界采样原始数据喂 observability。流式写出经 `runResponseSink`（buffered 变体 `runResponseBufferedSink`），均持注入的 `ClientSink`。

## 重试策略

S4 内首个匹配的 `RetryStrategy` 改写 env 重试。策略在 `src/lib/request/strategies/`：network、server-error（5xx 瞬时网关错误 ≤2 次退避）、token-refresh、effort-learning、legacy-thinking、unsupported-beta、deferred-tool、tool-field-rejection（学习上游拒绝的未知 custom-tool 顶层字段如 `eager_input_streaming`，排在 body-field 前）、server-tool-rejection、structured-outputs-rejection。各格式经 `codec/*/strategies.ts` 组装（Anthropic 全表 16 条），旧 strategy 经 `pipeline/legacy-strategy-adapter.ts` 适配进 driver。反应式重试的共享上限为 `state.maxReactiveRetries`（config `retry.max_reactive_retries`，喂给全部策略）。

## 错误分类与限速

错误分类见 `src/lib/error/`（classify/forward）；流式错误见 `src/lib/stream.ts`。429 由 `src/lib/adaptive-rate-limiter.ts`（3 模式 stateful 单例）在 transport 内消化。

## 旧管线

`src/lib/request/pipeline.ts` 的 `executeRequestPipeline` 现仅 web_search 双跳消费，余皆退役。

详见 DESIGN.md「请求流程」「活的架构现状」与运行时选项表 retry.* / rate_limiter.*。

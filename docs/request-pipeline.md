# 请求管线、重试与限速

v4 管线由 per-request driver 编排七阶段（S1–S7）。重试是错误驱动的 S4 重试环；限速由 generation dispatch scheduler 经 `UpstreamAdmissionController` 显式编排。

## 七阶段 driver

`src/lib/pipeline/driver.ts` 实现 S1 parse → S2 route/translate → S3 rewrite-in → S4 exchange（重试环）→ S5 rewrite-out → S6 render → S7 forward，并在阶段边界采样原始数据喂 observability。流式写出经 `runResponseSink`（buffered 变体 `runResponseBufferedSink`），均持注入的 `ClientSink`。

## 重试策略

S4 内首个匹配的 `RetryStrategy` 改写 env 重试。策略在 `src/lib/request/strategies/`：network、server-error（5xx 瞬时网关错误 ≤2 次退避）、token-refresh、effort-learning、legacy-thinking、unsupported-beta、deferred-tool、tool-field-rejection（学习上游拒绝的未知 custom-tool 顶层字段如 `eager_input_streaming`，排在 body-field 前）、server-tool-rejection、structured-outputs-rejection。各格式经 `codec/*/strategies.ts` 组装（Anthropic 全表 16 条），payload strategy 经 `pipeline/payload-strategy-adapter.ts` 适配进 envelope driver；共享 payload 契约由 `request/retry-types.ts` 单独拥有。反应式重试的共享上限为 `state.maxReactiveRetries`（config `retry.max_reactive_retries`，喂给全部策略）。

`network-retry` 除连接失败外，还处理上游 HTTP 499 的窄边界：仅当响应 body 为零长度或纯空白时，`classifyError` 才将其归为 `network_error`，等待 1 秒后用同一 payload 至多重试一次；非空 499 保持终态 `bad_request`，其他空正文 HTTP 状态仍按各自状态分类。首次失败的响应 headers 继续进入 per-attempt History；零长度 body 不物化为 `rawBody` 字段，纯空白 body 则原样保留。

## 错误分类与限速

错误分类核在 `packages/foundation/src/error/classify.ts`，客户端错误整形在 `src/lib/error/forward.ts`，流式错误在 `packages/foundation/src/stream.ts`。429 由 generation dispatch scheduler 通过 `UpstreamAdmissionController` 显式 acquire/observe 后创建新的 rate-limit dispatch；`src/lib/adaptive-rate-limiter.ts` 只提供三模式 admission 状态机，不再在 transport 内隐藏重放。

## 编排所有权

旧 `executeRequestPipeline` 已退役删除。所有 production 请求编排由 generation driver/candidate scheduler 拥有；`src/lib/request/` 仅保留 payload 工具、共享 retry contracts 与格式原生策略，不再拥有执行循环。

详见 DESIGN.md「请求流程」「活的架构现状」与运行时选项表 retry.* / rate_limiter.*。

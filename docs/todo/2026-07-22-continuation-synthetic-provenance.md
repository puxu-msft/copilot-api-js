# Deferred: continuation synthetic-provenance marker (spec §4.4)

- 状态：已解决（2026-07-27）。实现提交：`640813de`、`44989a14`、`7499c502`、`d60d1600`。
- 关联:spec `2026-07-22-continuation-retry-and-sequential-anchor.md` §4.4、ADR `2026-07-22-continuation-retry-sequential-anchor.md`(richest-data-flow「合成物必打可辨识标记」)、合并态审 Important-1。

## 解决结果

续写（continuation）构造合成上游请求 = `[原始体] + [assistant=已提交块] + [user=续写消息]`，由 `continuation.buildRequest` 产出普通 `MessagesPayload`，经 `contEnv = currentEnv.with({ body })` 发上游、由常规 `setGenerationDispatchWireRequest` 捕获进 `attempts[].upstreamRequest`。driver 现在按 `CandidateRole:"continuation"` 通过独立 `markGenerationDispatchSynthetic` 端口把 `synthetic: "continuation"` 写入 canonical `OperationTrack.synthetic` 一等字段及 transient `Attempt.synthetic`；History V3 与 observability 快照两条 producer 均将它投影为 `attempts[].upstreamRequest.synthetic`。真实 wire body 不含 marker，上游原始响应 track 也不含 marker。

真实持久化 oracle 位于 `tests/e2e-client/continuation-sdk.it.test.ts`：真实 SDK 请求触发 cut-path 续写，等待 V3 writer 后同时读取 canonical operation 与公共 `getHistory()` entry，断言合成请求体完整、标记存在、upstream-original response 未被污染。

## 根因 / 原行为


**已正确的部分**:
- 合成请求的**真实 wire 字节**被忠实记录进 `upstreamRequest`(richest-data-flow「后端存储必须完整」)。
- **上游原始响应轨**(`upstreamResponse.sseEvents`)只含真实上游帧,**未被污染**(§4.4 铁律)。

**缺口**:那两条合成 assistant/user 轮在 History 里**没有可辨识的 provenance 标记**——读 History 的人无法把它们与「客户端原始发来的轮」区分。spec §4.4 要求打 `synthetic:"continuation"` 标记。

## 理想架构(实现时)

**绝不**把 marker 写进真实 upstream body(会污染发给上游的字节)。应加**旁路 provenance 元数据**:
- `OperationSyntheticKind`(`model-operation-record.ts`)加 `"continuation"` 值(现有值:`"synthetic-message-start"` 等)。
- driver 在 `contEnv` → dispatch 记录链路上，给该 dispatch 的 upstreamRequest 一等字段打 `synthetic: "continuation"`（不进 body）。
- History V3 projection 把该 provenance 投影出来,供 UI/诊断查询。
- 补一条 History oracle:断言 continuation dispatch 的 `upstreamRequest` **既保留真实 wire payload、又带可查 continuation provenance**;`upstreamResponse` 保持真实上游帧、无该标记。

## 为何暂缓

纯**可观测性**完整性项,非功能缺陷:续写本身正确(客户端拿到缝合流,SDK e2e 验证)。marker 机制需要决定 provenance 字段落在记录链路的哪一层(env → sample → dispatch record),属独立小设计。当前 driver 注释已诚实标注此缺口(不再声称已打标记)。

## 若做需改什么

`src/lib/context/model-operation-record.ts`(OperationSyntheticKind 加值)、`src/lib/pipeline/driver.ts`(续写分支给 dispatch 打 provenance)、`src/lib/context/request.ts`(`setGenerationDispatchWireRequest` 链路保留 provenance)、`src/lib/history/v3/projection.ts`(投影)+ History oracle 测试。

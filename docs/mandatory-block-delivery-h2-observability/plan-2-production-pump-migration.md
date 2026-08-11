# Phase 2：Production Pump Migration

> 状态：`approved-not-implemented`
>
> 权威规格：[`docs/spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md`](../../spec/2026-08-06-mandatory-block-delivery-and-h2-termination-observability.md)
>
> 本目录只定义实施方法；规格是 what/why 单一事实源，当前 live 架构仍以 [`docs/DESIGN.md`](../../DESIGN.md) 为准。执行本阶段前必须先读 [`README.md`](README.md) 的 Global Constraints、文件责任边界、冻结跨层接口与 commit invariants。

## Task 5：迁移 11 个 production pumps

**Files**
- Modify: `src/routes/messages/{handler-v4,error-shaping-glue}.ts`、`src/lib/anthropic/warmup.ts`
- Modify: `src/routes/responses/{handler-v4,ws}.ts`
- Modify: `src/routes/chat-completions/handler-v4.ts`
- Modify: `src/routes/gemini/handler-v4.ts`
- Create: `tests/architecture/mandatory-delivery-graph.unit.test.ts`
- Extend endpoint tests under `tests/{anthropic,responses,chat-completions,pipeline,e2e-client}/`

**Migration order 与冻结 ratchet 集合**

以下集合在写 guard 时一次冻结，不能由实现扫描结果动态生成。每批 `pendingLegacy = frozenPumps - strictOwnerOnly` 机械派生，不手写第二份成员表：

| Batch | 本批新增 strict pumps | 批后 `strictOwnerOnly` 数量 |
|---|---|---|
| 0 基线 | 无 | 0 |
| 1 direct block | `src/routes/messages/handler-v4.ts::pumpAnthropicStreamingV4`；`src/routes/responses/handler-v4.ts::pumpStreamingV4` | 2 |
| 2 translate／reverse | `src/routes/messages/handler-v4.ts::pumpTranslateLegStreamingV4`；`src/routes/responses/handler-v4.ts::pumpReverseAnthropicLegV4`；`src/routes/chat-completions/handler-v4.ts::pumpReverseAnthropicLegV4`；`src/routes/gemini/handler-v4.ts::pumpReverseGeminiStreamingV4` | 6 |
| 3 response-terminal | `src/routes/chat-completions/handler-v4.ts::pumpStreamingV4`；`src/routes/responses/ws.ts::handleResponseCreateV4`；`src/routes/gemini/handler-v4.ts::pumpGeminiStreamingV4` | 9 |
| 4 synthetic | `src/lib/anthropic/warmup.ts::handleWarmupRequest`；`src/routes/messages/error-shaping-glue.ts::shapePrecommitError` | 11 |

- [ ] 用 TypeScript compiler API 冻结 spec §4.7 的 6 unique roots／上表 11 pumps，建立迁移 ratchet fixture。Batch 0 机械等式：`strictOwnerOnly = ∅`，`pendingLegacy = frozenPumps`；每个后续 batch 的 strict 集必须精确等于“上一批 strict + 表中本批 delta”，pending 只能由差集派生。始终要求两集合无交集且并集精确等于 frozen set。任何未知 exported streaming root／pump 立即红，禁止自动归入 pending。
- [ ] 对每个 `pendingLegacy` pump，guard 必须确认它仍只命中 spec §4.7 冻结的 legacy sink 类别（driver live／buffered branch 或直接 `stream.writeSSE`），不得新增旁路；对每个 `strictOwnerOnly` pump，必须 reach owner 且 no writer。每批以该批固定集合运行正样本，并分别注入“目标 pump 未迁仍留 pending”“实现已迁但漏移集合”“strict pump 恢复 legacy sink”三个 mutation，必须当批即红。
- [ ] 每迁一个 pump，先补 client-visible golden：完整块及时提交、半块不泄漏、terminal/error/[DONE] 顺序、synthetic marker、forwarded History；同一 commit 把本批 pump从 `pendingLegacy` 移入 `strictOwnerOnly`，其 owner可达／writer不可达双门立即生效。
- [ ] 批次1迁移 direct block paths并更新 ratchet，验证 anchor、continuation、retry、hedge winner／loser 与 output_item lifecycle。
- [ ] 批次2迁移 translate／reverse legs并更新ratchet；批次3迁移 response-terminal paths并更新ratchet，验证正常完整响应不会永久扣留，truncation清空全部response buffer。
- [ ] 批次4迁移 local synthetic paths、删除直接 `stream.writeSSE`，把最后 pumps移入 strict；同一 commit要求 `pendingLegacy` 精确为空，并切换为最终 6 roots／11 pumps全量 hard guard。
- [ ] 删除 route 终止帧／`[DONE]` 直写；所有 terminal 由 adapter renderer + owner 产生。
- [ ] 每批跑 ratchet guard与对应 endpoint goldens；最终跑全量11-pump guard、所有endpoint定向测试和client e2e mock tests。
- [ ] 注入已迁 pump退回live sink、漏移pending、从两集合删除pump、添加未知root、移除root→owner edge、route `[DONE]` mutation，确认分别红；每个中间批次的正确 fixture与最终11-pump集合均绿。
- [ ] 提交按上述 4 个子批次拆分，最后一笔：`refactor: route every streaming pump through delivery owner`。

## Task 6：退役 live／cap-retreat 配置双轨

**Files**
- Modify: `packages/foundation/src/{state,state-defaults}.ts`
- Modify: `src/lib/config/{schema,config,compat,model-overrides}.ts`
- Modify: `config.yaml`、`src/routes/status/route.ts`
- Modify: route buffered-config helpers and tests
- Modify: `src/lib/pipeline/driver.ts`／types to remove cap-retreat surface

- [ ] 写配置红测：新 schema 不暴露 delivery `enabled`／`buffer_cap_bytes`；旧 `false`／`protect_streaming_generation:false` 被接受、警告并只映射 `max_retries:0`；旧 `enabled:true`（含 Anthropic `"on"`／`"tool_use_only"`）无显式 retry 时保留 shared/default `max_retries`，有显式 `max_retries` 时保留原值；旧 cap 接受但忽略并警告。上述所有形状都不能改变 mandatory delivery。
- [ ] 保留 `max_retries`、heartbeat 与 continuation；把 runtime mode-switch 从 State／defaults／status 删除或改为 deprecated diagnostic，不得驱动 route。
- [ ] 删除 `bufferCapBytes`／retreated outcome／live branch；删除与 retreat 专属的 anchor collision 路径及更新后的测试。
- [ ] 更新 `config.yaml`、generated schema 描述、status projection；新配置只有永久 delivery + retry policy。
- [ ] 运行 config、hot-reload、state、schema、status 和 pipeline tests。
- [ ] architecture guard 扫描 production delivery boolean、cap retreat、`runResponseSink` 可达性必须为零；兼容 parser 正样本仍绿。
- [ ] 提交：`refactor: make block delivery unconditional`。

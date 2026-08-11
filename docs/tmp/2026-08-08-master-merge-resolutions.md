# 2026-08-08 master 语义合并取舍记录

合并基：`6d431481`。目标：组合 `worktree-placeholder` 的 pipeline/transport 与 History V3 Task 9 工作，以及 `master` 后续重构和修复；仅在一侧已被另一侧完整覆盖时舍弃重复实现。

### src/lib/context/model-operation-record.ts

- 我方意图：以 `copyCapturedArena` 显式计数并冻结 sealed arena copy，使 canonical capture work oracle 与实际复制工作同源。
- master 意图：用局部 `snapshotPayloads`/`snapshotFrames` 完成同样的 arena 浅复制，并手工遍历调用 observer。
- 最终取舍：保留我方 `copyCapturedArena` 单一 helper 和更精确的 “sealed-arena copies” 注释，舍弃 master 的等价内联循环。
- 理由：两侧行为目标相同；helper 是我方后续 AST recursion/工作量测试所依赖的单一实现，并避免复制逻辑与 observer 计数分写两遍。

### src/lib/history/queries.ts

- 我方意图：所有同步 summary 读取都先在同一 SQLite snapshot 内验证 projection readiness；若验证失败则回退 canonical V3 记录，避免返回不完整或陈旧 projection。
- master 意图：把 in-flight 与 recent terminal 统一成 `listHistoryOverlaySummaries`，确保 terminal publication overlay 在持久化完成前仍可见且按 ID 去重。
- 最终取舍：保留我方 validated-ready/canonical fallback、transient cursor 分流与 `buildSummaryResult`；输入改为 master 的统一 overlay，容量和合并参数同步按 overlay 计算。
- 理由：两项是不相互替代的独立不变量。统一 overlay 防止漏 recent terminal；validated snapshot 防止读到失效 projection。把 overlay 作为 transient 集合传入既避免 recent terminal 双计，也保留两侧分页、过滤与 total 语义。

### src/lib/history/v3/summary-schema.ts

- 我方意图：History V3 canonical operation 或引用的 transport evidence 改变时，把 summary projection 标为 pending/poisoned 并失效 readiness；维护 evidence refs 与受保护字段触发器。
- master 意图：仅包含 repository lint 风格调整。
- 最终取舍：核实 rerere 结果完整保留我方 readiness key、pending projection、validated assignments、protected-operation/evidence triggers，同时包含 master 格式化结果；直接接受并 stage。
- 理由：master 没有独立行为改动；现有无冲突文本保住 Task 9 的全部失效机制，且无冲突标记。

### tests/pipeline/client-sink.unit.test.ts

- 我方意图：为 parsed SSE delivery seam 扩展 sink 测试，覆盖 SSE `id`/`retry`/空 `id` 的线协议转发与采样。
- master 意图：仅应用 repository lint 格式。
- 最终取舍：核实 rerere 结果逐项保留我方新增 parsed SSE/id/retry 断言，并吸收 master 格式；直接接受并 stage。
- 理由：master 无相反行为，rerere 文件与我方语义内容一致且没有冲突标记。

### tests/pipeline/coordinator-hedge.unit.test.ts

- 我方意图：candidate response session 测试接入 Anthropic delivery protocol adapter，覆盖新的单次 delivery classification 契约。
- master 意图：增加 transport error tagging、hedge aggregate failure source 与 pre-content recovery 分类测试，并把可选 `onRenderedFrame` 接入 runtime fixture。
- 最终取舍：合并双方 import 和 fixture 字段；保留我方 `adapter`，同时保留 master 的 failure/recovery helpers 与 `onRenderedFrame` 接线。
- 理由：两侧测试不同职责且互补；删任一侧都会让对应生产重构失去回归覆盖。

### tests/history/v3/canonical-performance.unit.test.ts

- 我方意图：把 canonical capture 判据从脆弱名称/正则提升为 TypeScript AST call-graph SCC 检查，并保留显式 `copyCapturedArena` 与工作量比例断言。
- master 意图：保留确定性的 observer 工作量测试、15 秒 runtime budget，并增加简洁的单一 recursive freeze implementation 守卫。
- 最终取舍：组合双方：保留 AST SCC 与 rename/unrelated-recursion 反例、`copyCapturedArena` 断言、master 的 runtime timeout 和单一 freeze 正则守卫；去掉冲突产生的重复 fixture 采样。
- 理由：AST 守卫判别力更强，master 的简单结构守卫与 timeout 仍提供独立且廉价的回归信号；两者可同时成立。

### src/lib/pipeline/driver.ts

- 我方意图：parsed SSE/post-render transform 在 candidate processor 内只执行和分类一次；组合 outer/candidate callbacks，避免 buffered/unbuffered 路径重复调用并保留 assembled opts 类型门。
- master 意图：给 codec-render、downstream-sink、delivery-owner 与 upstream-transport 分开标注 failure provenance；sink 写失败和 predicate/flush 错误按来源返回。
- 最终取舍：保留我方单次 transform/classification、assembled opts 与 `attemptBaseOpts`；叠加 master 的 sink-write try/catch、`codecOperation` 包装、terminal predicate 错误归因和 response outcome 记录。删除 master 在 driver 再次调用 `onRenderedFrame` 的旧层。
- 理由：master 的 provenance 修复必须保留，但重复 post-render 会破坏我方“只分类一次”不变量。错误边界应包住实际 sink/predicate 操作，而不是恢复已上移到 processor 的重复 transform。

### src/lib/pipeline/stream/response-processor.ts

- 我方意图：全程携带 `TransportUpstreamFrame` 的 parsed SSE 元数据，只在 semantic hook/rewrite/render 边界投影；所有正常帧、rewrite flush 与 renderer finish 帧统一经过单一 post-render classification gate。
- master 意图：用 `ResponseCodecRenderError` 区分 codec 与 transport 失败，并在异常时保留 rewrite flush、记录 superseded/flush diagnostics。
- 最终取舍：以我方 parsed-frame 流为骨架，加入 master 的 per-frame/emit codec 包装、异常 flush helper、render/finish 包装和 superseded provenance；flush helper 同样投影 parsed SSE 并执行 post-render gate。
- 理由：两侧分别守住 wire 完整性与错误归因。直接选 master 会丢 parsed SSE 元数据，直接选我方会把 codec 错误误报为 transport；组合后两项不变量同时成立。

### src/lib/transport/http2-client.ts

- 我方意图：统一 recorder 捕获 headers/trailers/end/error/close/local-cancel/physical-close 终止证据，并由共享 `registerHttp2BodyTerminationHandlers` 驱动生产与确定性测试。
- master 意图：post-response abort listener 在 end/error/close 后及时 detach，避免已完成流保留 signal listener；取消仍等待 physical close。
- 最终取舍：保留我方 termination helper 和 physical-close 记录；把 master 的 listener lifecycle 下沉进该 helper，在 end/error/close/abort 时 detach，一处注册、一处清理；不再保留 runHttp2Fetch 的第二套 abort listener。
- 理由：直接并列两套 listener 会双发 `req.close` 并重复语义；共享 helper 才是两侧共同基座，同时满足证据完整性与 listener 清理。

### tests/transport/h2-keepalive-ping.unit.test.ts

- 我方意图：用 injected manual interval 确定性测试 cadence、重复 ping、禁用和 throw-swallow，不依赖 wall-clock。
- master 意图：补充 scheduler 收到配置 delay、timer `unref`、重复直到 clear 的断言，并用 event-driven wait 降低 sleep 波动。
- 最终取舍：以我方 manual scheduler 重写组合测试，同时加入 master 的 `unref` 和 clear 后不再调用断言；修正原我方 throw 测试未递增局部 `calls` 的错误，直接断 mock 次数。
- 理由：manual scheduler 比真实 interval/event wait 更快且完全确定；master 新增的 cadence/unref/clear 语义全部保留，无需引入 wall-clock。

## 合并后类型接缝修复

`bun run typecheck` 首次暴露四类自动合并接缝：candidate session 同时保留旧 `boundary.observe` 和新 `consumeFrame` 导致重复分类且签名不符；candidate race 留下已上移 transform 的死 helper；response processor helper 仍引用旧 `UpstreamFrame` 类型；master 新测试引用旧 readiness helper/直接读取 parsed-frame union。已分别收敛到单一 `consumeFrame`、删除死 helper、统一 `TransportUpstreamFrame`、改用 `validateAndMarkSummaryProjectionReady` 与 `semanticSseMessage`。这些是上述 10 个冲突组合后所必需的相邻根因修复，不改变既定契约。

## 跨子系统回归：recovery dispatch canonical frame value

- 复现：`bun test tests/routes/messages/precontent-recovery-matrix.it.test.ts` 初始为 39 pass / 2 fail；V2 `sseEvents` 和 dispatch settlement 正确，但 `dispatch.upstreamResponse.frames` 指向的 arena values 不再有顶层 `data`。
- 取证：`response-processor.ts` 的 dispatch capture 仍正常调用 `captureUpstreamGenerationDispatchFrame`；临时探针确认 recovery dispatch 捕获 6 帧，但每个 value 被 `canonicalFrameValue` 存成 `{kind:"parsed-sse", message:{data:...}, idField:...}`。因此链路未丢 handle，真正断点是 parsed SSE wrapper 泄漏进 canonical arena 的存储形状。
- master 意图：canonical arena 中的 SSE frame 使用稳定顶层 wire fields `{event,data,id,retry,type,synthetic}`；master 的 recovery publication/settlement 依赖该公共形状。
- 我方意图：parsed SSE 在 transport/pipeline 内保留 event-local `id` presence，避免把 inherited last-event-ID 错写回 wire。
- 最终取舍：在 `src/lib/context/request.ts` 新增统一 `canonicalFrameFields` 边界，把 parsed wrapper 投影回顶层 wire fields，并仅在 `idField.kind === "present"` 时存 `id`；`frameWireKey`、raw capture、canonical arena 三处共用该 primitive。同步更新 `tests/context/request-context.unit.test.ts` 与 `tests/pipeline/generation-runtime-baseline.http.test.ts`，明确 arena 存 canonical wire shape，而非内部 parser wrapper。
- 理由：parsed wrapper 是 transport 内部丰富语义，不是 History canonical frame 的外部契约；在存储边界投影既恢复 master/recovery 的顶层 `data`，又保留我方“只转发当前 event 真正携带的 id 字段”不变量。修复后 recovery matrix 为 41 pass / 0 fail，request-context 为 74 pass / 0 fail，generation runtime baseline 为 2 pass / 0 fail。
- 验证面修正：前次仅跑 `tests/history tests/pipeline tests/transport`，确实遗漏 `tests/routes`、`tests/infra`、`tests/chat-completions`；本轮按要求扩大套件，`tests/infra/entry-evidence-schema.unit.test.ts` 的机械 discovery baseline 由主会话另行处理，本执行者不修改。

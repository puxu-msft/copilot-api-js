# 验证报告：usage 归一化 backfill 对多 attempt 行的数据完整性

这是一个只读验证任务（非实现）。以下结论全部基于实读代码，file:line 为证。

## Q1 — 非 final attempt 的 outbound_response 行是否携带 usage？

**结论：不携带。多 attempt entry 实际上只有 1 条 outbound_response stage 行（final 那条）。**

证据链：
- `attempts[].response`（`OutboundResponseData`，含 `usage`，types.ts:213/331）只由 `setAttemptResponse` 写入（context/request.ts:410-416）。
- `setAttemptResponse` 全仓**唯一调用点**是 `complete()`（context/request.ts:483）。`complete()` 被 `settled` guard 保护（:469-470），每个请求只跑一次，且只在**成功的 final attempt** 上跑。
- 失败的非 final attempt 走 `setAttemptError`（driver.ts:289、pipeline.ts:299）——只写 `attempt.error`，**从不**写 `attempt.response`。
- L2 buffered-retry 的失败非 final attempt 走 `commitAttemptSseEvents`（driver.ts:616）只快照 sseEvents，也**不**写 response。
- 因此 `toHistoryEntry` 里 `response: a.response ?? undefined`（context/request.ts:684）对失败非 final attempt 恒为 `undefined`。
- `extractStagePayloads` 非 final 循环 `if (a.response) push(outbound_response, a.index, a.response)`（serialize.ts:493）的守卫**恒为 false** → 不写非 final 的 outbound_response 行。
- 只有 final slot（serialize.ts:506-509，`finalResponse = entry.outboundResponse ?? finalAttempt?.response`）会写 outbound_response 行，attempt_index = finalIdx。

→ plan section 3.1「一个 entry 可有多条 outbound_response 行」（plan:64）在**当前生产代码下是不成立的前提**：多 attempt entry 只有 final 那 1 条 outbound_response 行。plan 引 serialize.ts:493 作为「多条」依据，但 :493 的守卫在生产路径下永不触发。

## Q2 — backfill 是 per-row 算术还是 head-derived？plan 表述对不对？

**结论：plan 是 per-row 算术（正确），但基于一个不成立的前提（无害地正确）。**

- plan section 3.1（:67）：backfill「改**该行所有 `outbound_response` stage 行**的 blob（decompress→patch→compress）」——即**逐行读取该行自己的 usage、逐行做减法**，不是把 head 列算出的 net 写进所有 stage 行。这是 per-row self-consistent 算术，**正确**。
- plan section 3.2（:75）:`anthropic-messages` 行只置标记不减、`openai-*/gemini-*/responses` 才减；endpoint 决定「是否做减法」而非缩正确性面。
- 由于 Q1 证明每个 entry 只有 1 条 outbound_response 行（且其 usage 与 head 列同源，见 Q4），plan「所有 outbound_response 行」实际只作用于那 1 条 = head 列的镜像。per-row 减法与 head-derived 减法在此**结果等价**，无腐蚀风险。
- **不 WRONG，轻微 AMBIGUOUS**：plan 对「多条 outbound_response 行、每条 usage 可能各异」的担忧是**基于错误前提的过度防御**。真实数据里非 final attempt 无 usage → 无发散风险。plan 的 per-row 写法即便前提错了也 fail-safe（对唯一那条行读它自己的 usage 减，恒正确）。

## Q3 — detail UI 是否单独展示非 final attempt 的 usage？

**结论：否，divergence 不可见（且如 Q1 所述根本不存在）。**

- 全 ui-v4 只有 `MetaSegment.tsx` 引用 `attempts`，且只渲染 `entry.attemptCount`（计数，:26-28），**不**渲染任何 `attempts[i].response.usage`。
- usage 展示两处都读**顶层 mirror**：`MetaSegment.tsx:14` `entry.outboundResponse?.usage`、`DiagnosticBar.tsx:20` 同源。
- `grep "attempts\["` 全 ui-v4 **零命中**；无 AttemptsSegment 组件；StagesSegment 处理 request legs（messages）非 per-attempt usage。

→ 即使非 final 行 usage 与 final 发散，UI 也不会展示，用户不可见。

## Q4 — head 列与 final outbound_response blob 是否共享引用 → 被双减？

**结论：静态存储无共享引用；但两者同源（final attempt 的同一 usage 对象），backfill 必须对每个存储位点各减一次（共 2 处独立存储各减 1 次），不能对同一数字减 2 次。**

- head 列 `input_tokens/cache_read/cache_creation` 来自 `entry.outboundResponse?.usage`（serialize.ts:210, 222-225）。
- final outbound_response stage 行来自 `finalResponse = entry.outboundResponse ?? finalAttempt?.response`（serialize.ts:506）——**同一个 `entry.outboundResponse.usage` 对象**（运行时内存中确实共享引用）。
- 但**落盘后**是两处独立存储：head 列是裸 number 列；stage 行是独立压缩 JSON 帧（plan:64「每行 `compress(payload)` 单帧」）。at-rest 无共享引用。
- 风险点在于**内存重建**：若 backfill 用 `assembleFullEntry` 把 entry 读回内存，则 head 列还原的 usage 与 stage 行还原的 usage 可能指向同一对象（deserializeEntry 展开 head blob，assembleFullEntry 再叠 stage 行到 `attempts[i].response`——见 serialize.ts:307-367）。若代码对该内存对象减一次、再分别写回两处，两处都拿到 net（正确）；但若对两处「各减一次」而它们是同一引用，会 net-net（双减腐蚀）。
- plan section 3.1（:67）明确要求「改列 + 改 stage blob」是**两个独立存储位点各自 patch**，且 section 3.3（:79）「靶向解压（只解 outbound_response/head blob）」暗示分别解压/patch/压缩，不共享内存对象。**若实现严格分别读取 head 列数值与 stage blob 的 usage、各减一次并写回各自位点，则正确**。
- **实现期红线（plan 未显式点破）**：backfill 内部**绝不能**先 `assembleFullEntry` 得到一个 usage 对象、再把它同时当 head 列源和 stage 行源来减——那会因内存共享引用把同一对象减两次或让两处写入不一致。必须：(a) 从 head 列独立读 3 个 number 各减；(b) 从 stage blob 独立 decompress 出 usage 各减；两条腿互不复用同一内存对象。

## 综合裁定

- **plan 的多 attempt 处理：CORRECT（结果正确）但前提 AMBIGUOUS/冗余。** plan section 3.1 对「多条 outbound_response 行 usage 各异」的担忧在当前生产代码下不成立——多 attempt entry 只有 final 那 1 条 outbound_response 行（Q1 铁证：`setAttemptResponse` 唯一调用点是 `complete()`，非 final 失败 attempt 永不获得 response）。per-row 减法写法本身 fail-safe，即便前提错也不腐蚀。
- **无 divergence 风险（Q1）、无 UI 可见性问题（Q3）。**
- **唯一真实实现红线在 Q4**：head 列与 final stage blob 内存重建时同源共享引用，backfill 必须两处独立读取、各减一次，**禁止**复用同一内存 usage 对象双减。plan section 3.1/3.3 的分别-patch 措辞与此一致，但未显式点破「共享引用双减」这个具体陷阱——实现时须落到「head 列走列数值、stage 走 blob decompress，两腿不共享对象」。
- **附带观察（非 backfill 缺陷，但影响 plan 前提准确性）**：plan section 3.1 引 serialize.ts:493-509 论证「多条 outbound_response 行」，但 :493 守卫在生产路径恒 false。建议 plan 把该前提修正为「多 attempt entry 仅 final 1 条 outbound_response 行；per-row 写法对未来若真出现多条也 fail-safe」，避免误导实现者去构造并不存在的「非 final 行 usage 发散」测试夹具（plan section 4 的 `多 attempt 行断言各 outbound_response 行都被改` 会因只有 1 条行而语义落空——测试须对齐真实布局）。

# Phase 3 — 双 buffer 确定契约 + 映射规约（A1 前置）

> Stage A 的 Task 3。开场先读 [README.md](./README.md) 的通用红线 + 通用必读。**前置**：Phase 0 golden。**为 Phase 4 原子迁移铺契约**——本 phase 只确立并测试不变量，不迁移生产改写。

## 背景

Phase 4 要把 Anthropic 四条响应改写（recover-tool-call / thinking-signature-compat / tool-input-decode / server-tool-filter）**原子地**迁进 `RESPONSE_REWRITES`。它们当前在 `src/routes/messages/streaming-pump.ts:195-228` 手写嵌套（recover → decode → filter），靠**函数闭包顺序**隐式保证执行序与状态隔离。迁进 registry 后，顺序由 `order` 字段、状态由 `createState()` 显式承载——必须先把这套隐式契约**显式化为可测不变量**，否则 Phase 4 迁移无 oracle。

两个最危险的隐式契约：
1. **buffer/flush 确定性**：decode 与 recover 都会跨帧缓冲（buffer action）再在边界 flush。registry 的 `passThrough`（`driver.ts:277`）跑**整条链**才 yield，`flushChain`（`driver.ts:284`，Phase 1 已挪进 finally）在流末/异常 drain。必须确立：buffer 的帧在何时、以何顺序 flush，多 buffer 改写串联时上游 flush 输出如何喂下游改写（recover.flush → decode.transform → decode.flush，对齐现状 `handler-v4.ts:655-663` 的双 flush）。
2. **index 空间映射**：上游用 content block index 空间；server-tool-filter suppress 块后 densify（`server-tool-filter.ts:102` 的 `clientIndexMap`/`nextClientIndex`）；recover 合成块用 `maxUpstreamIndexSeen+k` 上游空间。两者**必须串在正确 order**（recover order=100 在 filter order=300 之前，对齐 `recover-tool-call/stream.ts:40` 的硬契约"假设跑在 serverToolFilter 之前"），否则 index 重映射错乱 → 客户端块错位。

## 目标

**不迁移生产改写**，而是：
1. 在 `rewrite-registry.ts` 把 `ResponseRewrite` 的 buffer/flush 语义 + order 契约用注释+类型固化（设计稿 §3.1 / §4.0.3）。
2. 新建 `tests/pipeline/response-rewrite-contract.unit.test.ts`，用 mock rewrite 锁死契约不变量：
   - 单 buffer 改写：buffer N 帧 → 边界 flush → 顺序 == 入序。
   - 双 buffer 串联：上游 flush 输出依 order 喂下游改写并再次经其 transform/flush（验证 `flushChain` 跨改写的级联 drain 顺序）。
   - index densify：mock filter 改写 suppress 中间块 → 后续帧 index 减 1，且 `content_block_start/delta/stop` 三类帧 index 一致重映射。
   - **异常路径**（接 Phase 1）：流中途抛错 → finally 的 flushChain 仍按 order drain 所有 buffer。

## 关键：order 常量表

把四条改写的 order 在 `rewrite-registry.ts` 定为命名常量并注释依据：
```ts
// 响应改写 order(小先跑):
//   recover-tool-call=100  必须在 server-tool-filter 前(recover-tool-call/stream.ts:40 硬契约)
//   thinking-signature-compat=150
//   tool-input-decode=200   在 recover 后(recover.flush 输出需再经 decode)
//   server-tool-filter=300  最后(densify 看到最终块集)
```
（这是 stage-a-plan.md factory 锚点表的 order 列，Phase 4 据此注册。）

## 验收

- 契约测试 PASS + **连跑 10-25×** 确认确定性（buffer/flush 时序敏感）。
- Phase 0 golden 仍绿（本 phase 无生产改写改动）。
- `bun run typecheck` 绿；`bunx eslint --fix`。
- **subagent 对抗 review**（全量工具）：让其尝试构造一个"通过契约测试但仍破坏 byte 等价"的反例，主线核其引用 file:line。

## 提交

```bash
git add -- src/lib/pipeline/rewrite-registry.ts tests/pipeline/response-rewrite-contract.unit.test.ts
git commit -m "test(pipeline): Stage A Task3 双 buffer 确定契约 + index 映射规约(A1 前置不变量)"
```

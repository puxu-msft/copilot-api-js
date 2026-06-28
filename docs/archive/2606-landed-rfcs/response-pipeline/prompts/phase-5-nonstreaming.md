# Phase 5 — 非流式 transformWhole（A.B）

> Stage A 的 Task 5 / 设计稿的 A.B。开场先读 [README.md](./README.md) 的通用红线 + 通用必读。**前置**：Phase 4（流式响应改写已入 registry）。

## 背景

Phase 4 迁的是**流式**逐帧改写。非流式（`stream:false`）走另一条路：`src/routes/messages/handler-v4.ts:466-516` 的 `renderNonStreamingV4`，按固定序对**整个 JSON 响应**应用 whole-response helper：
- `recoverToolCallTextInResponse`（`recover-tool-call/response.ts:21`）
- `decodeToolInputBlocksInResponse`（`decode-tool-input.ts:172`）
- `filterServerToolBlocksFromResponse`（`server-tool-filter.ts:176`）
- name restore（serverToolFilter 还原客户端原始 tool name）

这些目前**也是 handler 内联调用**，与流式改写在 registry 化后会形成"流式在 registry、非流式在 handler"的割裂。设计稿审计（§4.B）要求把非流式也纳入同一 registry——让一个改写条目**同时声明**流式 `transform/flush` 与非流式 `transformWhole`，"新增拦截"在两条路径自动覆盖。

## 目标

1. `ResponseRewrite` 接口加可选 `transformWhole?(response, env): unknown`（设计稿 §3.1，非流式整响应变换）。**注意**：审计已否决 `prelude` 字段（over-abstract，已从设计移除）——只加 `transformWhole`，不引入其它新成员。
2. 为 Phase 4 已注册的改写补 `transformWhole`（包装对应的 `*InResponse` helper）：recover→`recoverToolCallTextInResponse`、decode→`decodeToolInputBlocksInResponse`、filter→`filterServerToolBlocksFromResponse`+name restore。thinking-signature-compat 仅流式（非流式 JSON signature 客户端直读，无需 shim，对齐 DESIGN.md 该字段说明）→ 不加 transformWhole 或留 no-op。
3. driver 暴露一个非流式编排入口（如 `runResponseWhole(response, env)`），按 order 依次跑各改写的 `transformWhole`；`renderNonStreamingV4` 改调它，删 handler 内联序列。

## 关键约束

- **顺序等价**：非流式 helper 现有执行序（recover→decode→filter→name-restore，`handler-v4.ts:466-516`）必须靠同一套 order 常量复刻（与流式共用 order，Phase 3 已固化）。
- **非流式 golden**：Phase 0 已含非流式场景（server-tool 过滤、decode、name restore、recover）。迁后这些 golden 逐字节等价是硬 gate。
- **H3 双 flush / 异常**：非流式无 streaming flush，但 `handler-v4.ts:655-663`（双 flush）、`:695-710`（H3 异常 flush）是**流式**路径的兜底——确认本 phase 只动非流式分支，不回退 Phase 1/4 对流式的处理。

## TDD

1. 改前 Phase 0 非流式 golden 已锁。
2. 加 `transformWhole` 到接口 + 类型（typecheck 绿，no-op 不改行为）→ 可单独 commit。
3. 逐条把非流式 helper 接进 registry transformWhole + driver 编排入口 + handler 改调 → 非流式 golden 等价 → commit。
4. 删 `renderNonStreamingV4` 内联 helper 序列（grep 确认无其它消费者）。

## 验收

- 非流式 golden 逐字节等价 + Phase 4 流式 golden 仍绿（确认未误伤流式）。
- `bun run test:backend` 绿；`bun run typecheck` 绿；`bunx eslint --fix`。
- **subagent 对抗 review**（全量工具）：核 transformWhole 顺序 == 现有内联序、name-restore 是否仍在 filter 之后、thinking 非流式确无需变换。主线亲核 file:line。

## 提交

```bash
git add -- src/lib/pipeline/rewrite-registry.ts src/lib/pipeline/driver.ts src/routes/messages/handler-v4.ts tests/...
git commit -m "refactor(pipeline): Stage A A.B 非流式 transformWhole 纳入 registry(recover/decode/filter+name-restore)"
```

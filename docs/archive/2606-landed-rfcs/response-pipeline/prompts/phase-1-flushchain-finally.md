# Phase 1 — flushChain 进 try/finally（H3 前置）

> Stage A 的 Task 1。开场先读 [README.md](./README.md) 的通用红线 + 通用必读。**前置**：Phase 0 golden 已建。

## 背景 + 为什么

RFC §4.0.5 + 审计实测核实——`src/lib/pipeline/driver.ts` 的 `runResponse`（generator）里，`flushChain` 在 `for await (frame of upstream.frames)` 循环**之后**但**不在 try/finally**（约 driver.ts:284）。异常时（upstream 抛错、或 handler 消费时抛错触发 generator return）这行**不执行**。

Stage A 后续（Phase 4）把 buffering rewrite（decode/recover）迁进 registry 后会暴露问题：**异常路径下 driver 的 registry buffer 既不被 driver flush（flushChain 不在 finally）、handler 又拿不到 registry 的 `states`（在 driver 内）→ buffer 静默丢失**，客户端少收 tool_use 片段。这破坏 H3（现状 `handler-v4.ts:695-710` catch 里手动 flush 兜底；迁进 registry 后这条兜底没了）。

**必须把此修复前置**——它是 generator 模型下就能做的 B3 最小子集，当前 `RESPONSE_REWRITES` 为空、行为 no-op，但为后续 buffering rewrite 入 registry 铺好安全垫。

## 目标

把 `runResponse` 的 `for await` + `flushChain` 包进 try/finally：

```ts
async function* runResponse(deps, upstream, env) {
  const rewrites = assembleResponseRewrites(env, deps.responseRewrites ?? RESPONSE_REWRITES)
  const states = rewrites.map((r) => r.createState?.() ?? {})
  // ... upstreamSse 采样别名 + streamStartMs（P3.2b，保持不变）...
  try {
    for await (const frame of upstream.frames) {
      // ... upstreamSse 采样（[DONE] skip 等，P3.2b 逻辑保持不变）...
      for (const rewritten of passThrough([frame], rewrites, states, 0)) yield* renderFrames(deps, rewritten, env)
    }
  } finally {
    for (const flushed of flushChain(rewrites, states)) yield* renderFrames(deps, flushed, env)
  }
}
```

正常完成 + 异常（消费者 break/抛错触发 generator `.return()`/`.throw()`）两路都 drain registry buffer。**严格保持 P3.2b/P3 收尾的 upstreamSse 采样别名逻辑 + `[DONE]` skip 不变**（别在重构 try 块时误删）。

## TDD

在 `tests/pipeline/driver.unit.test.ts` 加测试：mock 一个 buffering `ResponseRewrite`（`transform` 返回 `{kind:"buffer"}`、`flush` 返回缓冲帧）+ 一个在 N 帧后抛错的 `upstream.frames`。断言：异常被消费者捕获，且 flush 的帧在异常前已 yield（即 finally 跑了 flushChain）。

- 先跑验证 **FAIL**（现状 flushChain 不在 finally，异常时 flushed 帧丢失）：`bun test tests/pipeline/driver.unit.test.ts -t "flush on exception"`。
- 实现后 **PASS**。

## 验收

- 新测试 PASS + `bun test tests/pipeline/driver.unit.test.ts` 全绿。
- **Phase 0 golden 全绿**（行为 no-op，应无变化）+ `bun run test:backend` 绿（2 个预存 FileSink 失败正交）。
- `bun run typecheck` 绿；`bunx eslint --fix src/lib/pipeline/driver.ts`。
- **subagent 对抗 review**（全量工具）：核验"finally 里 yield 不破坏正常路径的 upstreamSse 采样/forwarded 时序"，主线亲自核 driver.ts 改动 file:line。

## 提交

```bash
git add -- src/lib/pipeline/driver.ts tests/pipeline/driver.unit.test.ts
git commit -m "fix(pipeline): Stage A Task1 flushChain 进 try/finally(H3 前置,异常路径也 drain registry buffer)"
```

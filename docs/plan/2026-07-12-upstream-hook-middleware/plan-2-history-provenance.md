# Phase 2：history 可辨识性（synthetic 标记）

> 依赖：Phase 0（loader）+ Phase 1（driver 挂载点）。承重不变量（评审 BLOCK-1/H2 双确认）：hook mock/改写/回放帧进 history 上游轨**必打可辨识标记**，否则毒化诊断真相（违 richest-data-flow ADR）。

**设计：driver 如何辨识 hook 产物**——`UpstreamStream` 与 `UpstreamFrame` 携带内部标记（不入 wire、只供 driver 采样时读）：
- **mock 流**：helper（Phase 3）产出的 mock/replay `UpstreamStream` 挂一个内部符号属性 `[HOOK_ORIGIN]: "hook-mock" | "hook-replay"`。driver 采样时读它给 `upstreamSse.push` 标记。
- **改写帧**：`rewriteUpstreamFrame` 返回了不同于原 frame 的对象时，driver 标记该帧 `hook-rewrite`（但注意 §3.4 决策 2：改写帧只进 forwarded，上游轨记 pre-hook——所以 `hook-rewrite` 标记落在 **forwarded track** 的采样，不是上游轨）。

---

## Task 2.1：扩展 `SseEventRecord.synthetic` 联合

**Files:** Modify `src/lib/history/types.ts:164`；可选对称 Modify `src/lib/pipeline/client-sink.ts:167`（forwarded 侧）。Test：类型层，随消费点测试覆盖。

```ts
// history/types.ts:164
  synthetic?: "keepalive" | "anchor" | "synthetic-message-start" | "hook-mock" | "hook-rewrite" | "hook-replay"
```

> 勘探 C.3 核实：ui-v4 [SseEventsSegment.tsx:27-34](../../ui-v4/src/components/detail/segments/SseEventsSegment.tsx#L27) 只把 `synthetic` 当字符串渲染、**无 exhaustive switch**——新成员不打爆 `typecheck:ui-v4`。`client-sink.ts:167` 的复制联合是 forwarded 侧，若要让 `hook-rewrite` 落 forwarded 轨则须同步扩它（见 Task 2.3）。

- [ ] **Step 1：改 types.ts:164** → **Step 2：`bun run typecheck` + `typecheck:ui-v4` 绿**（证不打爆）→ **Step 3：commit**。

## Task 2.2：mock/replay 流的 `HOOK_ORIGIN` 标记 + 上游轨打标

**Files:** Create `src/lib/pipeline/hooks/origin.ts`（符号常量）；Modify `src/lib/pipeline/driver.ts`（[runResponse](../../src/lib/pipeline/driver.ts#L440) 行 440 push）；Test `tests/pipeline/hooks/driver-provenance.unit.test.ts`。

```ts
// origin.ts
export const HOOK_ORIGIN = Symbol("hookOrigin")
export type HookOrigin = "hook-mock" | "hook-replay"
export function tagStream(s: UpstreamStream, origin: HookOrigin): UpstreamStream {
  return Object.assign(s, { [HOOK_ORIGIN]: origin })
}
export function readOrigin(s: UpstreamStream): HookOrigin | undefined {
  return (s as Record<symbol, unknown>)[HOOK_ORIGIN] as HookOrigin | undefined
}
```

driver.ts 行 440（`runResponse` 收到的 `upstream` 若带 origin，则 push 时标记）：

```ts
      if (frame.data !== "[DONE]") {
        const origin = readOrigin(upstream)  // upstream is runResponse 的入参
        upstreamSse.push({ offsetMs: ..., type: ..., raw: frame.data ?? "", ...(origin && { synthetic: origin }) })
```

- [ ] **Step 1：写失败测试** — 构 `tagStream(mockStream, "hook-mock")` 传给 `runResponse`，断言产出的 `upstreamSse` 每帧带 `synthetic:"hook-mock"`；未标记的真实流 → 帧**不带** synthetic。
- [ ] **Step 2-4：跑失败 → 建 origin.ts + 改 driver → 跑绿 + golden 等价**（未标记流字节等价）。
- [ ] **Step 5：commit**。

## Task 2.3：`rewriteUpstreamFrame` 改写帧的 forwarded 标记

**Files:** Modify `src/lib/pipeline/driver.ts`（Task 1.3 插入点附近）+ `src/lib/pipeline/client-sink.ts:167`（forwarded 采样接受 `hook-rewrite`）；Test 同 2.2。

当 `rewriteUpstreamFrame` 返回了 ≠ 原 frame 的帧，该帧经 rewrite 链 + render 后走 forwarded 采样时标 `hook-rewrite`。实现：driver 在 Task 1.3 处记 `frameWasRewritten` 布尔，透传到 forwarded 采样（`client-sink.ts` 的 `sampleForwarded` 第二参）。

> 若实现复杂度超预期（forwarded 采样在 owns-sink 路径较深），**降级方案**：首版只保证「改写帧不污染上游轨」（Task 1.3 已保证——上游轨记 pre-hook），`hook-rewrite` 的 forwarded 标记记 `docs/todo/deferred-backlog.md` 后续。上游轨纯净是承重底线，forwarded 标记是增强。执行者按实际复杂度决定，并在 commit message 说明。

- [ ] **Step 1：写测试** — 挂改写 hook，断言 forwarded 轨改写帧带 `hook-rewrite`（或降级：断言上游轨纯净 + 记 backlog）。
- [ ] **Step 2-4：跑 → 实现/降级 → 跑绿 + typecheck**。
- [ ] **Step 5：commit**。

**Phase 2 出口验收**：mock/replay 帧上游轨带标记、真实帧不带、改写不污染上游轨；`typecheck` + `typecheck:ui-v4` 绿。

# Phase 2：history 可辨识性（synthetic 标记）

> 依赖：Phase 0（loader）+ Phase 1（driver 挂载点）。承重不变量（评审 BLOCK-1/H2 双确认）：hook mock/改写/回放帧进 history 上游轨**必打可辨识标记**，否则毒化诊断真相（违 richest-data-flow ADR）。

**设计：driver 如何辨识 hook 产物**——`UpstreamStream` 与 `UpstreamFrame` 携带内部标记（不入 wire、只供 driver 采样时读）：
- **mock 流**：helper（Phase 3）产出的 mock/replay `UpstreamStream` 挂一个内部符号属性 `[HOOK_ORIGIN]: "hook-mock" | "hook-replay"`。driver 采样时读它给 `upstreamSse.push` 标记。
- **改写帧**：`rewriteUpstreamFrame` 返回了不同于原 frame 的对象时，driver 标记该帧 `hook-rewrite`（但注意 §3.4 决策 2：改写帧只进 forwarded，上游轨记 pre-hook——所以 `hook-rewrite` 标记落在 **forwarded track** 的采样，不是上游轨）。

---

## Task 2.1：扩展 `SseEventRecord.synthetic` 联合

**Files:** Modify `src/lib/history/types.ts:164`；Modify `src/lib/pipeline/client-sink.ts:167`（forwarded 侧联合，Task 2.3 需要）。Test：类型层，随消费点测试覆盖。

```ts
// history/types.ts:164
  synthetic?: "keepalive" | "anchor" | "synthetic-message-start" | "hook-mock" | "hook-rewrite" | "hook-replay"
```

```ts
// client-sink.ts:167 —— forwarded 侧采样参数联合同步扩 "hook-rewrite"（Task 2.3 透传用）
const sampleForwarded = (frame: ClientFrame, synthetic?: "keepalive" | "anchor" | "synthetic-message-start" | "hook-rewrite"): void => {
```

> 勘探 C.3 核实：ui-v4 [SseEventsSegment.tsx:27-34](../../ui-v4/src/components/detail/segments/SseEventsSegment.tsx#L27) 只把 `synthetic` 当字符串渲染、**无 exhaustive switch**——新成员不打爆 `typecheck:ui-v4`。上游轨标记（`hook-mock`/`hook-replay`）落 history/types.ts；forwarded 侧只需 `hook-rewrite`。

- [ ] **Step 1：改 types.ts:164 + client-sink.ts:167** → **Step 2：`bun run typecheck` + `typecheck:ui-v4` 绿**（证不打爆）→ **Step 3：commit**。

## Task 2.2：mock/replay 流的 `HOOK_ORIGIN` 标记 + 上游轨打标

**Files:** Modify `src/lib/pipeline/driver.ts`（[runResponse](../../src/lib/pipeline/driver.ts#L440) 行 440 push）；Test `tests/pipeline/hooks/driver-provenance.unit.test.ts`。

> `origin.ts`（`HOOK_ORIGIN`/`tagStream`/`readOrigin`）已在 **Phase 0 Task 0.7** 创建（评审 HIGH-1 上移），本 Task 只**消费**它。

driver.ts 行 440（`runResponse` 入参 `upstream` 若带 origin，则 push 时标记）。**`readOrigin(upstream)` 上提到 for-await 循环外算一次**（评审 LOW-2，origin 对整个流恒定）：

```ts
  const origin = readOrigin(upstream)  // 循环外，整流恒定
  for await (const frame of upstream.frames) {
    if (frame.data !== "[DONE]") {
      upstreamSse.push({ offsetMs: ..., type: ..., raw: frame.data ?? "", ...(origin && { synthetic: origin }) })
```

- [ ] **Step 1：写失败测试** — 构 `tagStream(mockStream, "hook-mock")` 传给 `runResponse`，断言产出的 `upstreamSse` 每帧带 `synthetic:"hook-mock"`；未标记的真实流 → 帧**不带** synthetic。
- [ ] **Step 2-4：跑失败 → 改 driver（消费 Phase 0 的 `readOrigin`）→ 跑绿 + golden 等价**（未标记流字节等价）。
- [ ] **Step 5：commit**。

## Task 2.3：`rewriteUpstreamFrame` 改写帧的 forwarded 标记

**Files:** Modify `src/lib/pipeline/driver.ts`（Task 1.3 插入点附近）+ `src/lib/pipeline/client-sink.ts:167`（forwarded 采样联合扩 `hook-rewrite`）；Test 同 2.2。

**本轮实现（非降级，评审 MEDIUM-1）**：`hook-rewrite` 是 spec §3.4 明列、§9 有测试断言的 ADR 级可观测性属性——richest-data-flow「合成物必打可辨识标记」对 forwarded 轨同样承重，**不由执行者自决砍**。当 `rewriteUpstreamFrame` 返回 ≠ 原 frame 的帧，driver 在 Task 1.3 处记 `frameWasRewritten` 布尔，透传经 `renderFrames → yield → runResponseSink → sink` 到 forwarded 采样（扩 `client-sink.ts:167` 的 `sampleForwarded` 第二参联合加 `"hook-rewrite"`），改写帧走 forwarded 时标 `hook-rewrite`。

> **接缝提示**（评审确认非平凡）：forwarded 采样 `sampleForwarded` 在 handler/sink 侧、经 `onForwarded` 回调，透传布尔要跨 owns-sink 边界。执行者若实测此接线成本远超预期，**须回来向用户报告、由用户签字决定是否降级**（记 spec §3.4/§9 修订 + backlog），**不得在 commit 里静默降级**（`no-silently-cut-but-defer`）。上游轨纯净底线由 Task 1.3 独立保证，与本项无关。

- [x] **Step 1：写失败测试** — 挂改写 hook，断言 forwarded 轨改写帧带 `hook-rewrite`、上游轨仍是 pre-hook 纯净帧。（`tests/pipeline/hooks/driver-provenance.unit.test.ts` 新增 describe「hook-rewrite forwarded-track hook-rewrite marking (Task 2.3)」5 个用例。）
- [x] **Step 2-4：跑失败 → 实现透传 + 扩联合 → 跑绿 + typecheck + typecheck:ui-v4**。
- [x] **Step 5：commit**。

**实际实现（与初稿设想略有出入，记录以免复议）**：未采用"布尔透传经 opts 回调"的形状，改用 Symbol-keyed 帧标记（`hooks/origin.ts` 新增 `tagFrameRewritten`/`wasFrameRewritten`，`tagStream`/`HOOK_ORIGIN` 的帧级近亲）——driver 在 rewriteUpstreamFrame 返回 ≠ 原帧时打标，`client-sink.ts` 的 `write()`（SSE + WS 两个工厂）直接读标决定 `sampleForwarded` 的第二参，**不新增 `ClientSink` 接口方法**（未走 writeKeepalive/writeAnchor 那种"driver 主动选调用点"的形状——因为 hook-rewrite 帧是普通内容帧、和其他真实帧走同一个 `write()` 调用，driver 没有独立调用点可选）。改动 3 文件（driver.ts / client-sink.ts / hooks/origin.ts），均属 `src/lib/pipeline/` 编排层，未碰任何 handler。**覆盖实测**（非猜测，`bun -e` 验证过对象展开保留 Symbol 键）：Anthropic `/v1/messages` 直连 + CC `/chat/completions` 直连可靠；Responses(HTTP+WS) 直连（既有 `restoreAndAccumulate`/`restoreAccumulateCount` 重建全新字面量，与 hook 无关的既有模式）+ 全部 translate 腿（stream translator 是有状态 N:1/1:N 累加器，"帧"边界本身不对应）**丢标——记入 backlog**「`hook-rewrite` forwarded 标记覆盖缺口」，非静默降级。

**Phase 2 出口验收**：mock/replay 帧上游轨带标记、真实帧不带、改写不污染上游轨；`typecheck` + `typecheck:ui-v4` 绿。

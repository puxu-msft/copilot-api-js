---
name: methodology-upstream-original-projection-misses-forwarded-only-rewrite
description: 读 upstream-original 轨的投影/日志看不到「只在 forwarded 轨合成的」rewrite 产物（recover/filter），须经 feature/side channel 旁路传名，勿污染上游轨
metadata: 
  node_type: memory
  type: project
  originSessionId: 0673be80-bf48-4ede-9ba2-2c0bcefd68c8
---

TUI 完成行 / 投影函数从 **upstream-original 轨**（`attempts[-1].upstreamResponse.body`）派生的信号，**看不到只在 forwarded/client 轨合成或改写的 rewrite 产物**。因为按 richest-data-flow「Option A」，上游轨永远保留上游原始字节（`onUpstreamFrame` 在 rewrite 链**之前**累积），合成物只进 forwarded 轨。

实例（2026-07-14）：tool-call recover 把降级文本重建为 `tool_use` 只进 forwarded 轨，完成行读上游轨→`toolNamesFromResponseBody` 返 `[]`→裸 `tool_use`、`[RECOVER]` 行也不带名。两条日志都漏名。

**根因修法**：在「产物唯一可知的时点」（recoverer 内部）把信息经**已有的 feature/side channel** 旁路传出（`recordFeature("tool-call-recovered", { tools })`→bus→TUI stash→完成行 fallback），**绝不**为了让消费端可见而把合成物写回上游轨（破坏轨道纯度）。消费端做**精确 fallback**（upstream 有值优先、否则用旁路值），因两来源互斥（recover 要求 `!sawToolUseBlock`）。

**同类站点须一并 grep**：任何 `toolNamesFromResponseBody` / `finalUpstreamResponse().body` 的读取点都有同款盲区。reviewer 逮到第二处 `resolveResponseToolNames`（当前无消费者，已记 `docs/todo/deferred-backlog.md`）——History 侧若要 fallback，须先把 recovered names 落**持久化通道**（`recordFeature` 不落 history，持久化诊断走 `pipelineInfo`，见 [[methodology-plan-verify-interface-location-and-wiring-channel]]）。

对称面见 ADR `2026-07-05-richest-data-flow`：上游轨绝不含合成物 / 合成物打标记 [[feedback-synthetic-data-must-be-distinguishable-from-real]]；多比较点复发规律 [[feedback-fix-all-comparison-sites]]。权威 = commit 617d3340 + 代码注释。

---
name: methodology-diagnostic-log-is-authoritative-voice-verify-against-ground-truth
description: 诊断/日志行本身是会撒谎的权威声音（计数器可能只接了部分代码路径）；别信自报、探独立 ground truth；宽松信号收集 API 诱发静默误报
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 40d435f9-28bc-429b-9588-22c15f7aeec0
---

**一条诊断/可观测性日志行，本身就是一个可能撒谎的「权威声音」——它的计数器可能只接了部分代码路径，对其它路径恒打全零。别把诊断行的自报当真相，用独立 ground truth 复核。** 属 verification 簇（user skill `verifying-authoritative-claims`、[[feedback-pass-null-clean-not-self-validating]]、skill `empirical-verification`），但对象是**我方自己的日志**而非 subagent/文档。

实例（gpt-5.6-sol 断流事故，2026-07-14）：`[upstream-diagnostics] STREAM DISCONNECT` 打出 `frames=0 bytes=0 last-frame=none@0ms silence=313462ms tokens=0/0`，表面像「上游整段零响应 / 中间设备 idle 回收 thinking-stall」。我第一版分析**信了它**、据此推断根因。用户push「你没理由不去检查」→ 探 4141 History 上游原始轨（`attempts[].upstreamResponse.sseEvents`），发现**真相相反**：上游流了 312s／3484 帧、客户端收 3475 个真实 `content_block_delta`，是被上游 `NGHTTP2_CANCEL` **封顶砍断**的健康长流。`frames=0` 是因为 `logUpstreamStreamError` 的计数器只接了 messages 直连 pump 的 `sseEvents`，而这条 `/v1/messages`→翻译`/responses` 的 translate leg **硬编码传空壳**（`bytesIn:0`/空 acc/`[]`）。

**How to apply**：① 诊断行/日志计数出现「全零/none/整段静默」这种极端读数时，先怀疑「这个计数器接到这条路径了吗」，别直接当症状；② 用独立 ground truth（history 双轨 sseEvents、`GET /openapi.json`、真库探针）复核，可信度 实测 > 日志自报；③ 尤其翻译/多出站腿（cc/responses/gemini）与原生腿常各走各的 pump，一条腿有的观测另一条腿未必接。

**配套 API 设计教训**：`logUpstreamStreamError` 当时收整个 Anthropic 专有 `StreamPumpState`+accumulator——正是这个「必须造完整结构」的宽松签名，诱导 translate leg「造个空壳塞进去」。根治=**收紧入参为它实际消费的最小结构子集**（`{streamStartMs,bytesIn,currentBlockType}`+`{inputTokens,outputTokens}`），类型系统前置逼**所有**调用点提供真实值（同 [[feedback-fix-all-comparison-sites]] 的正向版：用类型逼出全站点）。宽松的信号收集 API = 静默误报的温床。

**第二轮系统化 + 「designed out」自称不自证（2026-07-14）**：把诊断抽成共享 leaf `src/lib/upstream-stream-diagnostics.ts`（发射点 `logUpstreamStreamError` + `createUpstreamFrameDiagnostics` primitive 无条件计所有帧含 `[DONE]`/空），接线**全部 7 条非原生-Anthropic pump**。教训：我在 docstring 自称「the SINGLE emission point for EVERY non-native pump / bug class designed out」，却**漏了 gemini 两条 pump**（同盲区、连 `onUpstreamFrame` 都没传）——正是 [[feedback-fix-all-comparison-sites]] 的复发：即便建共享 primitive 来「消灭整类 bug」，也必须 **grep 穷举全部 stream-error pump 逐条核**，「已覆盖 all」的自称**不自证**、要独立枚举证伪。合并态 reviewer 逮到（[[methodology-cross-phase-integration-seam-only-caught-at-merged-state]]）。**注意循环依赖**：该 leaf 依赖 `~/lib/error`，而 `~/lib/error` 已 import `~/lib/upstream-diagnostics`，故发射点**不能**放进 `upstream-diagnostics.ts`，须独立 leaf。

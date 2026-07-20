# Spec：流式路径 history 轨 & 观测完整性（第二轮）

> ⛔ **已被取代（SUPERSEDED，2026-07-20）** → [2026-07-20-synthetic-frame-forwarded-track-completeness.md](2026-07-20-synthetic-frame-forwarded-track-completeness.md)。
> 三轮大重构（request-lifecycle cancel/settle/quiesce、upstream-error-client-shaping、buffered-merge/candidate-response-session）之后，本文所有 `file:line` 锚点已失效，且三处前提已过时或不精确：① reaper-cancel 从「排除、handler 不处理」变成 catch 块内联处理（结论不变但措辞已错）；② Unit 2 两函数已合并为单一 `responseFrame`；③ Unit 3「仅 tag frame」不足——`writeSynthetic` 不读 `readSyntheticKind(frame)`，且 backlog:592「仍打 error-shaping-canonical」经实测证伪。**新 spec 已合并三单元并纠正这些偏差，请以新 spec 为准。** 本文仅存档，勿据以实施。

> 状态：**设计定稿（两轮异模型对抗审查 + 用户范围决策），待用户审 → writing-plans**。日期 2026-07-14。
> 派生自 gpt-5.6-sol 断流事故第一轮修复后的 backlog 巡检（找与「诊断只从部分 pump 发」同构的完整性缺口）。
> 评审：Claude `reviewer` + GPT `gpt-souls:reviewer` 各一轮（GPT 首轮因 NGHTTP2_CANCEL 中断、重派并交叉核验 Claude 发现）。两轮均 0 blocker、逐条 file:line 核实。

## 目标与判据

**统一主题（richest-data-flow 完整性）**：到达客户端 wire 的帧 / provenance 标记 / 错误整形决策，必须**也**落进 history 转发轨（`clientResponse.sseEvents`）/ telemetry 维度，且合成帧必与真实上游帧可辨识。三个**逻辑独立、可各自交付**的单元，均**非大重构**。

**明确排除本轮范围**（用户 2026-07-14 决策，记 backlog）：
- **reaper-cancel 腿的 history 完整性** —— reaper（`context/manager.ts:251`）在 handler catch 运行前**已同步** `ctx.fail()` finalize entry（`context/request.ts:702` settled 一次性），故客户端已收到的 reaper error 帧 + 锚点 stop@0 **永不进 history**。单靠单元1 的 handler 重排无法修（重排只改已 settle 的 ctx）。两位 reviewer 均判其需一个「取消优先、settle 兜底」的**两阶段 reaper 协议**（触及 manager 的 settle 语义、大重构）。→ 见 `docs/todo/deferred-backlog.md`「reaper-cancel history 两阶段协议」。
- **⑥ h2 PING 运行时可观测性** —— 归入独立大特性 `docs/todo/upstream-transport-observability.md`。
- **②b translate 腿 per-frame hook-rewrite provenance** —— N:1/1:M 有状态累加器「输出帧溯源到哪个输入帧」语义 ill-defined（`origin.ts:49-52`）；用户决策「可选不强求、可日后做」。本轮仅 best-effort 一个 **ctx/流级粗标记**（「本 translate 流发生过 ≥1 次 hook 改写」），若实现非平凡则延后 + 文档化 content-diff 兜底，**不**侵入式重设计 translator。

---

## 单元 1 — ⑤ delayed-commit history 轨补 error 帧 + 锚点收口帧

**现状（bug）**：`src/routes/messages/handler-v4.ts:491-545` delayed-commit catch 块，`ctx.setForwardedResponse(snapshot, ~497)` 在各失败腿的 `closeAnchorIfOpen + writeSynthetic(errorFrame)`（508-544）**之前**，且 `ctx.fail` 也在 writeSynthetic 之前 → 客户端收到的 error 帧 + 锚点 stop@0 **不进** `clientResponse.sseEvents`（wire 正确、仅 history 轨缺）。违反 `client-sink.ts:24-29` 的 `writeSynthetic → recordForwarded → settle` 契约。

**修复（仅 handler 自 settle 的 4 腿）**：timeout、HTTPError、unknown-non-HTTP、`!result.ok` reject 四腿，改为每腿内部：
```
closeAnchorIfOpen → writeSynthetic(errorFrame) → setForwardedResponse(snapshot) → ctx.fail
```
- **必须 `finally` 兜底 settle**（GPT-major）：`closeAnchorIfOpen`（`keepalive-anchor.ts:113` await writeAnchor）与 `writeSynthetic`（`client-sink.ts:269` 返真 write promise）**可 reject**；当前 catch 无 `.catch`。若把 settle 挪到 write 后而不兜底，一次 write reject 会**跳过 setForwardedResponse + fail → 请求永不 settle**（比现状「history 缺帧」更糟）。抽 `writeTerminalThenSettle(sink, anchor, buildFrame, settle)` helper：best-effort terminal write（帧在 write 尝试时已同步 sample 进 forwardedSseEvents，符合项目「recorded == attempted-to-send」约定），无论成败在 `finally` 中 snapshot + fail。
- **client-abort 腿（502-505）保持 `snapshot → abort`**（不写 error 帧、不写锚点）：其 stall 期 pings 正是靠 abort 前的 setForwardedResponse 落轨。不套用无差别重排。
- **reaper-cancel 腿（506-514）不动**（重排对它无效，见「排除范围」）；重排本身对该腿无 wire 回归（fail 本就 no-op、writeSynthetic 照常上线）。

**验收测试**：对 timeout / HTTPError / unknown / `!result.ok` 四腿，断言 history `clientResponse.sseEvents` 帧序 == 实际 sink 帧序（含 `anchor stop@0`（若注锚）+ error 帧）；client-abort 腿断言零额外 wire、history 只含 pings；补一条 write-reject 下仍 settle 的回归。

---

## 单元 2 — ②a Responses 直连/WS 恢复 hook-rewrite 标记

**现状**：`responses/handler-v4.ts:389 restoreAndAccumulate` 返回 `{ event: frame.event ?? event.type, data }`、`ws.ts:353 restoreAccumulateCount` 返回 `{ data }`，均**重建全新字面量**，丢掉 Symbol-keyed `hook-rewrite` provenance（`origin.ts`）+ `id`/`retry`。

**修复**：
- **HTTP**（`restoreAndAccumulate`，driver loop + viaFallback closing drain 共享）：改 `{ ...frame, event: frame.event ?? event.type, data: restoreResponsesStreamFrameToolNames(...) }`。**event 回退必须显式保留**（两 reviewer major）：viaFallback 腿的帧是 CC→Responses 翻译新建、`frame.event===undefined`，纯 `{...frame, data}` 会让 `client-sink.ts:172` 因 event undefined **省略 `event:` 行** → 破 wire。展开使 Symbol 标记 + id/retry 随行。
- **WS**（`restoreAccumulateCount`）：改 `{ ...frame, data: X }`。WS wire 仅发 `frame.data`（`ws.ts` sendRaw），故 event/id/retry **对 WS wire 无效**；收益是 **history 转发轨**——`makeWsSink.write` 也 `sampleForwarded(frame, readSyntheticKind(frame))`（已核实），标记进轨。
- **id/retry 保真（HTTP）= richest-data-flow 改进**（既有丢弃缺陷的顺带修复）：真实 Responses 帧通常无 `id:`/`retry:` 行，预计零 wire 变化；如动 golden（`responses-v4.http.test.ts` / `c0-ws-terminal-golden.http.test.ts`）按「有意的更完整转发」重对齐、spec 记明。

**②b（best-effort）**：ctx/流级布尔粗标记（**不**进 per-frame forwarded 记录，避免污染 per-frame 语义），translate 腿改写命中即置位，history 读时暴露「本流有 hook 改写」。若接线非平凡则延后 + 文档化「靠上游轨/forwarded 轨 content-diff 定位」。

**验收测试**：Responses HTTP direct + fallback：`hook-rewrite` Symbol 存活、`event:` 回退存活、id/retry 保真；WS direct + fallback：`hook-rewrite` 进 forwarded history、并断言 event/id/retry **不属** WS wire（防误期望）。

---

## 单元 3 — ④ raw-stream 终点补 error-shaping 观测 + 修 synthetic 误标

**现状（双缺陷）**：`shapeRawStreamErrorFrame`（`error-shaping-glue.ts:200`）在 4 个调用点（`handler-v4.ts:1180` direct-H3 / `1294` direct-截断 / `1451` translate-H3 / `1482` translate-截断）产客户端合成 canonical error 帧，但：
1. **无 telemetry 维度**：不调 `decide()`（`error-shaping.ts:91`），无 `error-shaping-decided` FeatureKind（那是 glue pre/post-commit 的 ApiError 分类路径）。
2. **synthetic 误标**（GPT 升为 major，已核实）：返回**未打** `tagFrameSynthetic` 的帧；而 H2 路径 `error-frame-canonical-rewrite.ts:53` 明确 `tagFrameSynthetic(..., "error-shaping-canonical")`。故 raw-stream 合成帧在 history 转发轨里**冒充真实上游帧**，违反「合成帧必可辨识」（richest-data-flow §3）。

**修复**：
- **加专属 FeatureKind** `error-shaping-raw-canonical`，detail 固定 `{ wireErrorType: string, terminus: "stream-error" | "truncation", leg: "direct" | "translate" }`：
  - **`wireErrorType` 独立命名**（不复用 `error-shaping-decided.errorType`）：后者是 `ApiErrorType` 枚举，raw 侧是 wire 字符串（`api_error` / `overloaded_error` / `timeout_error` 等，`error-shaping.ts:219` 家族），**同名会害跨-kind 聚合混值域**。
  - **在 ctx.fail 前记录**（`recordFeature` 后于 fail 会漏冻结 entry，同 backlog 既有陷阱）。
  - 更新 `tui/terminal-ui.ts:1294-1345` 的穷尽 FeatureKind switch。
- **修 synthetic 误标**：`shapeRawStreamErrorFrame` 返回 `tagFrameSynthetic(buildCanonicalErrorFrame(...), "error-shaping-canonical")`（`state.errorShapingEnabled` 关时仍返 legacyFrame 逐字、不打标，保 CF-2 golden lock）。
- **不硬塞 `decide()` / classify 复原 ApiErrorType**（两 reviewer 一致）：raw-stream H3 是 transport/stream lifecycle failure、truncation 无可还原的原始 ApiError，伪造成 `network_error`/`server_error` 制造**虚假诊断**（正属「ill-defined 硬塞」）。专属维度是长远正确形状。
- **范围声明**：仅覆盖 4 个 canonical raw 终点。另 3 处**非-canonical** handler 合成 error 帧（`handler-v4.ts:1268` tool-input-unrepairable / `1317` direct-pump 意外 throw / `1505` translate-pump 意外 throw，各有 `tool-input-unrepairable` / `failureReason` 别的观测）**明确不在本单元**、不偷渡进 raw-canonical 指标。

**验收测试**：4 个 canonical 终点（direct/translate × H3/截断）均断言：① forwarded history 帧带 `synthetic:"error-shaping-canonical"`；② 记 `error-shaping-raw-canonical` FeatureKind 且值域正确；③ 在 fail snapshot 前记录。非-canonical 3 处断言**不**被计入 raw-canonical 维度。

---

## 单元独立性 & merge 卫生

三单元逻辑独立、可各自交付。仅 ⑤（`messages/handler-v4.ts:491-545`）与 ④（同文件 1180/1294/1451/1482 + FeatureKind）改动同文件不同区域，属 merge 卫生（行级共存 + 显式 pathspec），非设计耦合。②a（`responses/*`）与 ④（`messages/*` + `error-shaping-glue.ts`）零文件重叠。

## backlog 更新（随实施）

- **关闭/替换** `docs/todo/deferred-backlog.md:514-519`（④ 落地后）；**更正**其中「帧级已可辨识」错误前提（raw-stream writeSynthetic 原本无标记，本单元才补）+ 非-canonical 三处准确写点（1268/1317/1505，非旧 1499）。
- **新增** backlog 项「reaper-cancel history 两阶段协议」（排除范围，见上）。
- **②b** 若延后：backlog 记「translate 腿 per-frame provenance ill-defined、粗标记未做」。

## 非目标（YAGNI）

- 不重设计 stream translator 携 per-frame provenance（②b ill-defined）。
- 不改 reaper settle 语义（本轮排除）。
- 不为「所有 proxy 合成 terminal error 统一可观测」建通用 provenance 层（那是另一 spec；本单元只治 canonical raw 4 点 + 其误标）。

# Contentless refusal 抑制 —— 合并态复审（第四轮，跨 T1–T5 集成缝）

> 评审对象：`feat/refusal-diagnostics` 分支 `master..HEAD` 全部提交的**最终合并态代码**。前三轮审的是设计文档，本轮审代码的集成缝。
> 评审者：Claude 底座（异模型对抗——四个执行者里三个是 GPT）。
> 落盘说明：评审 agent 运行环境未启用 `Write`，本文由主会话据其报告转录，并保留其原始证据编号。

## 总体判断

**BLOCKER = 0；修复 HIGH-1、HIGH-2 后可合并回 master。** HIGH 2 · MED 8 · LOW 5 · 主观建议 5。

Anthropic 直连腿（`/v1/messages`）的抑制链路**设计扎实、实现正确、测试有真裁决力**（三个一手样本当只读 fixture、expected 手写不 import 生产常量、真 SQLite 往返、真 `@anthropic-ai/sdk` oracle、`requestBucket` 结构性互斥，均经评审独立复核成立）。问题集中在**边缘腿与守卫覆盖**。

## 处理状态

| 编号 | 结论 | 处理 |
|---|---|---|
| HIGH-1 默认翻转零守卫 | 主会话独立复现 | ✅ 已修（`tests/anthropic/refusal-default-oracle.unit.test.ts`，3 条全过 mutation control） |
| HIGH-2 reverse 腿 refusal 无处置 | 主会话独立复核 | ✅ 已修（见下） |
| MED-1 翻译 marker 接线零测试 | 评审实测 | ✅ 已修 |
| MED-2 冻结策略只冻 mode | 主会话确认 | ✅ 已修（模板改读快照 + 空值回落收进构造处） |
| MED-6 遥测 success 就地改语义 | 与判据自相矛盾 | ✅ 已修（新增上游腿 measure） |
| MED-7 文档不同步（3 处） | 逐处核实 | ✅ 已修 |
| MED-8 三模式 × 消费面覆盖不等 | `rg` 命中 1 条断言 | ✅ 已修 |
| MED-3/4/5、LOW-1..5 | 见下 | 记档待办 |

---

## HIGH-1 · 默认翻成 `end_turn` 零测试守护

`src/lib/state-defaults.ts:163`。D-1「默认从 `error` 改为 `end_turn`」是整个分支的存在理由，spec §8 明确要求「测试必须**省略** `refusal_sse_rewrite` 才能证明默认真的翻转」。

**mutation control（评审与主会话各跑一次，结果一致）**：把默认改回 `"error"` →

```
6526 tests · 6512 pass / 14 fail   ← 翻回 "error"
6526 tests · 6512 pass / 14 fail   ← 分支当前 "end_turn"
```

**逐字相同，零测试变红。**

根因：`response-rewrite-golden.http.test.ts` 与 `anthropic-sdk.it.test.ts` 每条用例都显式 `setStateForTests({refusalSseRewrite})`；`anthropic-cli.e2e.test.ts` 配置写死且离线不跑；`config-hot-reload.it.test.ts:820` 用 `defaultStateValue: CONFIG_MANAGED_DEFAULTS.refusalSseRewrite` —— **expected 即被测生产常量**，自证循环，恰是本轮 spec §6.1 禁止的形状。

**为何不是测试洁癖**：一次无关的 config 重构、一次 `CONFIG_MANAGED_DEFAULTS` 合并取错边，都能把默认值悄悄改回去而全套件全绿——首要目标静默失效，只有真人用 CC 才会发现。

## HIGH-2 · reverse `@messages` 腿的 contentless refusal 完全没有处置，且未记档

`src/lib/pipeline/non-streaming-completeness.ts:22-24` 的 `anthropicNonStreamingTruncation(stopReason)` 只在 `stop_reason` 为**空**时返回截断理由；`"refusal"` 是真值 → 返回 `null` → 三条 handler（`chat-completions` / `responses` / `gemini` 的 `handler-v4.ts`）走 `ctx.complete()`。

**后果链**：请求记 `completed`/`success` → `requestBucket()` 归成功桶 → `/api/stats` 记成功；同时遥测因 `stopReason==="refusal"` 打上 `refusal_category` → **遥测里出现「成功的 refusal」**，与 `/v1/messages` 腿的「失败的 refusal」同维度两种口径；TUI 打 `[ OK ]`；History UI 却照常渲染红色 Refusal 诊断块；客户端拿到 `finish_reason:"content_filter"` + 空 content，**首要目标在该腿完全没兑现**。

**为何不能算「不在范围内」**：`docs/refusal-recovery.md` 写「三种模式终态一律 `failed`」与「计数以裁决为唯一权威」，**未限定**到 Anthropic 直连腿；本轮**已经**把这三条腿纳入改动（补了 raw `stop_details` 落盘与翻译降级 marker）；而已知缺口节**没有**列这条——违反 `no-silently-cut-but-defer`。**做一半而不记档比完全没做更危险。**

---

## 仍待办（已记档，未在本批修）

- **MED-3 · category→显示串四套并列实现，且在 `category:""` 上已经分叉**。`refusalCategoryForDiagnostics`（遥测/TUI/feature/marker）、`renderRefusalTemplate`（**客户端可见文本**）、`refusalSummary`（日志/failureReason）、`resolveRefusalDetail`（History UI）四处各自映射三态。空串一格已分叉：`extractRefusalDetail` 标 `invalid:true` 但保留原值，而 `renderRefusalTemplate` 只判 `undefined`/`null`，会把空串插进客户端可见文本，渲染出「（拒绝类别：）」。建议在零依赖叶子加唯一 `categoryProvenance()` 原语让三处消费。→ 正是 `feedback-fix-all-comparison-sites` 的形状，现在四点差一格，成本最低。
- **MED-4 · UI 的 refusal 门与 TUI/遥测不同**。TUI/遥测判 `stopReason === "refusal"`，`entry-view.ts:127` 只判 `stopDetails` 是否存在（其测试把契约写死成「returns undefined **only** when raw stopDetails are absent」，是有意为之）。上游一旦给别的 `stop_reason` 也挂 `stop_details`，History UI 会标成「Refusal diagnostic」而 TUI/遥测正确地不认。建议拆成 `resolveStopDetailsRaw`（无条件，供 RawJsonView）+ `resolveRefusalDetail`（带门，供带 refusal 字样的标题）。
- **MED-5 · 透传模式 + 无 `message_stop` 时 refusal 可观测性静默丢失**。`handler-v4.ts` 的门是 `isContentlessRefusal(…) && (mode !== "refusal" || acc.sawMessageStop)`；透传 + clean EOF 无终止符落截断分支 → `failureReason` 变成「传输截断」掩盖真实根因、feature 不记，但 TUI token 与遥测维度仍命中（二者读上游腿）→ 同一请求四个面各说各话。**wire 行为是深思熟虑的**（透传没发终止符、客户端仍需终结符），缺陷在于**可观测性跟着 wire 一起被丢**——这两件事本该解耦（D-8 讲的就是这个）。建议把 refusal 的观测从 wire 分支里剥出来。
- **LOW-1 · `recover-refusal.ts` 的 re-export 让消费者可绕过零依赖叶子**，无守卫无警告；`circular-deps-ratchet` 只在真成环时才咬，一条新边可能要等第二条边补上才暴露。建议注释显式约束「`lib/` 侧必须直连叶子」，或删掉 re-export。
- **LOW-2 · degradation `target` 无 Gemini**：Gemini codec 委托 CC codec，marker 记 `target:"openai-cc"`，按 target 分组永远看不到 Gemini。
- **LOW-3 · 残留 `thinking-only` 措辞**：生产注释 3 处（`context/types.ts`、`context/request.ts`、`pipeline/rewrite-registry.ts`）+ 测试 12 处。spec 要求删除的三类（日志/`ctx.fail` 文案/客户端默认文案）已清干净。
- **LOW-4 · `stopDetails` 只写不清**：与相邻的 `stopReason` 同构（**不是新引入的不一致**），但 continuation 续写若复用同一 accumulator，第 1 轮的 `stop_details` 会被带进第 2 轮终态记录。**评审标注为未实测假设**——需先确认 continuation 是否复用 accumulator。
- **LOW-5 · 非流式抑制路径判据可读性**：`isRefusal` 判的 `response` 已过 S5 `transformWhole`（抑制模式下已被改成 `end_turn`），读者需跑测试才能确定分支走向。建议参数改名点明「链前/链后」。

## 主观建议（未采纳/待议）

- 两个零依赖叶子职责清晰、无重复、SCC 目标达成；唯一可改进是 `refusal-detail` 同时承载「stop_details 解析」与「翻译降级 marker 类型」，二者无逻辑关系。**再进第三类概念时再拆**。
- 三模式表下应补一条**用户可操作结论**：配置了 CC `refusalFallbackModel` 的用户，默认 `end_turn` 与 `error` 都会让 CC 看不见 refusal、原生 fallback 永不触发；想保留请显式设 `refusal_sse_rewrite: refusal`。
- TUI FAIL 行 category 出现两次（`extra` 的 token + `effect.error` 里的 `(category=…)`）。
- spec §5 #16 与落地形状不同：spec 写 detail `{category, disposition}`，落地是 `{category}` + 三个 FeatureKind 穷尽 Record —— **落地形状更好**（类型系统能逼出新模式），应回改 spec 那一格。

---

## 已核实无问题（附证据，避免下一轮重复排查）

- **`stop_details` 贯通链无断点**：accumulator `stream-accumulator.ts:129,403-405` → streaming builder `recording.ts:114` → 非流式 inline builder `handler-v4.ts:932,976` → `ResponseData` `context/types.ts:114-115` → `PartialResponseInfo` `:126-127` → `fail()` 两支 `request.ts:1738,1752` → `abort()` `:1817` → `legFromUpstreamResponse` `:181` → canonical `responseMetadata` `:783` → V3 projection 类型 `projection.ts:226` + 白名单 `:337` → 锁步双 owner → `entry-view.ts:127` → UI。spec §5 #1–#11 全中。
- **「还有别的聚合读上游腿当请求成败吗」= 没有（生产路径）**：`queries.ts:76-77` 的 `responseSuccess` 对 V3 摘要由 `projection.ts:432 state === "completed"` 产生 = 裁决；`in-flight.ts:176` 的回落路径生产上是 **test-only seam**（`entries.ts:42-48` 自述，唯一调用者是 test seam）；`stats.ts:188` 的 entry 来自 V3 投影；`ui-v4/src/lib/activity-row.ts:18-19` 只在 `state` 缺失时回落。→ **stats.ts + telemetry sink 两处修复已覆盖全部生产聚合点。**
- **四条翻译路径 + 三条 reverse route builder 全部落地**（不是只做被测的那几条），Gemini 经委托继承。
- **hedge 并发安全成立**：`ctx.refusalPolicy` 懒冻结不可变无 setter；每 candidate 一个 rewriter；handler 从**本 candidate** 的 `acc` 推导。B-2 根因确已消除。
- **`exactly-one-COMPLETE-terminus` 有真 oracle**：转移表逐格覆盖 + 两条正控 + 真 SDK 独立 oracle。
- **`requestBucket` 互斥性是结构性的**：单 switch 单 return，枚举测试会在新增 state 时暴露。
- **既有失败与本分支无关**：HEAD 与「默认改回 error」两种状态下失败集合恒定（6512/14）；ui-v4 vitest 563/563 全绿。

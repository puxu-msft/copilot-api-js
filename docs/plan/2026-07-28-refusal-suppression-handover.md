# 交接：contentless refusal 抑制 —— 剩余工作

> 状态测于 **`1bee331d`**（2026-07-28）。主体已合并回 master（`d108366b`），**本文只交接未做的部分**。
> 已完成部分的设计与结论**不在本文复述**，见 §1 必读清单——本文写指针，不写副本。

## 0. Kick-off 提示词（可直接粘进新会话）

```
接手 copilot-api-js 的 contentless refusal 抑制的剩余工作。

先按顺序读这四份，别跳：
1. docs/refusal-recovery.md —— 现状契约（这是活的真相源，不是历史文档）
2. docs/plan/2026-07-28-refusal-suppression-handover.md —— 本交接件，剩余项与判据都在这
3. docs/spec/2026-07-27-refusal-diagnostics-and-typing-review-merged-state.md —— 第四轮合并态复审，
   剩余项的原始论证与 file:line 在这里，别只看交接件的摘要
4. exp/refusal-samples/FINDINGS.md —— 三个真实上游样本的一手字节，写任何测试都用它当 fixture

动手前先跑一遍，确认交接件没过期（它写于 1bee331d，master 移动很快）：
  git log --oneline 1bee331d..HEAD -- src/lib/anthropic src/routes docs/refusal-recovery.md

剩余项按 R1 → R2 → R3 顺序做，R1 是唯一影响用户可观测行为的。每项的判据、触点、
以及「为什么之前没做」都在交接件 §2。
```

## 1. 必读清单（附为什么必读）

| 文件 | 为什么必读 |
|---|---|
| [docs/refusal-recovery.md](../refusal-recovery.md) | **现状契约**。默认值、三模式语义、exactly-one-COMPLETE-terminus、冻结策略与 hedge 的关系都在这。不读会重新引入已修掉的问题 |
| [本交接件](2026-07-28-refusal-suppression-handover.md) | 剩余项与判据 |
| [第四轮合并态复审](../spec/2026-07-27-refusal-diagnostics-and-typing-review-merged-state.md) | 剩余项的**原始论证与 `file:line`**。交接件只摘要，动手前读它引用的每一处 |
| [exp/refusal-samples/FINDINGS.md](../../exp/refusal-samples/FINDINGS.md) | 三个真实样本的一手字节（category `null`/`bio`/`cyber`）。**写任何 refusal 测试都用它当只读 fixture，expected 手写** |
| [docs/spec/2026-07-27-refusal-diagnostics-and-typing.md](../spec/2026-07-27-refusal-diagnostics-and-typing.md) | 设计源 + §3 未采纳方案（含理由）。**做 R3 前必读 §3.2**，否则会重新论证一遍已经论证过的东西 |
| [已完成部分的执行记录](2026-07-28-refusal-suppression-remaining-tasks.md) | T1–T5 的落地方式与 mutation control 证据。只在「为什么当时那样做」时查 |

**高发区提醒**：改 `src/lib/anthropic/refusal-detail.ts` / `refusal-policy.ts` 时注意它们是**零依赖叶子**——存在的唯一理由是不把 rewrite 图拖进 19 模块 core SCC。往里加 import 会被 `tests/architecture/circular-deps-ratchet.unit.test.ts` 咬。本轮已经踩过两次。

## 2. 剩余项

### R1 · reverse `@messages` 三条腿的跨协议抑制（唯一影响用户可观测行为的一项）

**已核实仍未做**（`1bee331d`：三条 handler 只有 settle gate，`openai-cc`/`openai-responses` codec 里 `RefusalPolicy` 零命中）。

- **现状**：客户端用 CC / Responses / Gemini 格式、上游走 Anthropic 时，contentless refusal 的**裁决口径已统一**（`ctx.fail(..., {upstreamSucceeded:true})` + `refusal-passthrough` feature），但**wire 没有抑制**——客户端仍收到 CC 的 `finish_reason:"content_filter"`、Responses 的 `status:"incomplete"`、Gemini 的对应形态。
- **因此首要目标在这三条腿上没兑现**：这些客户端的对话轮次仍会被打断。默认 `anthropic.refusal_sse_rewrite="end_turn"` 对它们**不产生任何抑制效果**。
- **为什么之前没做**：本批的 HIGH 缺陷是「裁决与计数口径错误」（请求被记成 `completed`，遥测出现「成功的 refusal」），那个能独立闭合；真正的抑制要在三个目标协议里各实现一遍「合成正常完成轮」，是独立一批的工作量。**这不是被砍掉，是被拆出来的**。
- **若做需改什么**（复审给的路线，我未验证其完整性）：① 把 `RefusalPolicy` + detail/template vars 提升为**协议无关**的 whole-response disposition；② 在三个 reverse renderer 里各实现 `end_turn`/`refusal`/`error`；③ 保证目标协议的 exactly-one terminus 与 raw/forwarded 双轨；④ feature 从当前写死的 `refusal-passthrough` 改成实际 mode；⑤ 三条腿各补 byte golden + **官方 SDK 消费 oracle**，并补至少一条同 session 后续轮可继续的客户端测试。
- **判据**：三条腿在默认配置下，客户端拿到的是各自协议的**正常完成轮**，且同 session 下一轮能继续。**别只用状态机单测收口**——本轮的教训是真 SDK/CLI oracle 才能裁决「轮次会不会断」。
- **完整记录**：`docs/todo/deferred-backlog.md` 的「reverse `@messages` 非流式跨协议 refusal 抑制」条目。

### R2 · 复审 MED-4 / MED-5（口径不一致，不影响 wire）

两条都**已核实仍成立**：

- **MED-4**：`entry-view.ts:resolveRefusalDetail` 的门是「`stopDetails` 存在」，而 TUI（`lifecycle.ts`）与遥测（`telemetry-dimensions.ts`）的门是「`stopReason === "refusal"`」。上游一旦给别的 `stop_reason` 也挂 `stop_details`，History UI 会渲染出「Refusal diagnostic」而 TUI/遥测正确地不认。**注意这是有意为之的**（`tests/history/entry-view-refusal-detail.unit.test.ts` 把契约写死成「只在 stopDetails 缺失时返回 undefined」），所以改之前先决定要哪种语义。复审建议拆成 `resolveStopDetailsRaw`（无条件，供 RawJsonView）+ `resolveRefusalDetail`（带 stopReason 门，供带 refusal 字样的标题）。
- **MED-5**：`handler-v4.ts:1457` 的门是 `isContentlessRefusal(...) && (mode !== "refusal" || acc.sawMessageStop)`。**透传模式 + clean EOF 无 `message_stop`** 时落截断分支：`failureReason` 变成「传输截断」掩盖真实根因、feature 不记，但 TUI token 与遥测维度仍命中（二者读上游腿）→ 同一请求四个面各说各话。**wire 行为是深思熟虑的**（透传没发终止符、客户端仍需终结符），缺陷在于**可观测性跟着 wire 一起被丢**。修法：把 refusal 的**观测**从 wire 分支里剥出来，进分支链前先无条件判定一次。

### R3 · 代理侧 fallback 重试（未采纳，非「不值得」）

**已核实仍未做**（`src/lib/request/strategies/` 零命中）。

上游在每个 refusal 的 `explanation` 里建议的就是这条，CC 也内建了它——而**我们的抑制恰恰挡住了 CC 自己那条腿**（这是抑制的已知代价，不是遗漏，已写进 `refusal-recovery.md` 的用户可操作结论）。

**做之前必须先做三个实验，当前全部未验证，别当事实用**：同 payload 换模型的恢复率；同 payload 同模型重发是否必然再拒（官方文档只说 "usually"）；`category` 能否预测可恢复性（`cyber`/`bio`/`null` 三类已观测，但**无任何**行为差异证据——`bio` 那次是烧了 25,636 thinking token 之后才拒的）。

完整记录（含循环安全、计费可辨识、与抑制的优先级）：`docs/todo/deferred-backlog.md` 的「代理侧 refusal fallback 重试」条目。

### R4 · 零散项（LOW，均已核实仍成立）

| 项 | 现状 | 判据 |
|---|---|---|
| LOW-1 re-export 可绕过零依赖叶子 | `recover-refusal.ts:76/114/276` 三处 re-export，`lib/` 侧消费者可绕过叶子直连；`circular-deps-ratchet` 只在真成环时才咬，一条新边可能要等第二条才暴露 | 加显式约束注释，或删 re-export 让 `routes/` 也直连 |
| LOW-2 degradation `target` 无 gemini | `refusal-detail.ts:91` 是 `"openai-cc" \| "openai-responses"`；Gemini 委托 CC codec，marker 记成 `openai-cc`，按 target 分组永远看不到 Gemini | 加 `"gemini"`，或拆成 `hop` + `clientFormat` |
| LOW-3 残留 `thinking-only` 措辞 | `src/` 下仍有 **8 处**（`grep -rn "thinking-only" src/ --include=*.ts`），均为注释；spec 要求删的三类（日志 / `ctx.fail` 文案 / 客户端默认文案）已清干净 | 概念名统一为 contentless refusal |
| LOW-5 非流式判据可读性 | `handler-v4.ts` 的 `isRefusal` 判的 `response` 已过 S5 `transformWhole`（抑制模式下已被改成 `end_turn`），读者需跑测试才能确定分支走向 | 参数改名点明「链前/链后」 |

**LOW-4 已基本消解，不必再排查**：复审担心 continuation 复用同一 accumulator 会把上一轮的 `stopDetails` 带进下一轮终态。我查了 `driver.ts`：continuation 走 `coordinator.runContinuation(...)` 返回**新 candidate**，而 session/accumulator 是 per-candidate 创建的（`driver.ts:531`）。**证据指向不成立，但我没写探针最终证实**——若要动这块再确认一次。

## 3. 计划 vs 实际（差异表）

比计划本身值钱的部分——**这几条都是被证据推翻的，不是「后来觉得不好」**：

| 原计划怎么写的 | 实际怎么做的 | 被什么推翻的 |
|---|---|---|
| 按 `category` 分型，加 3 个 config 键分别配 mode/文案 | **全部删除**，category 只作诊断维度 | 取证：`bio` 样本烧了 25,636 thinking token 才拒 → 「带 category = 推理前拦截」被证伪；「重发必再拒」从来没做过实验。分型的**行为差异前提**不成立，只剩诊断差异 |
| 默认保持 `error`（上游语义失败应显式失败） | **默认翻成 `end_turn` 抑制** | 用户裁定：下游处理烂，首要目标是不中断对话轮次。CC 源码逐行核实：透传与 error 的终点**都是结束当前轮** |
| 原生 refusal 透传 + failed verdict（架构评审提案） | **未采纳** | 同上。该提案论据经核实**属实**（CC 有 category 感知渲染与自动 fallback），但终点仍是结束当前轮 |
| 用 ctx 上的**因果信号**让 handler 读「改写层实际做了什么」 | 改成**请求级不可变策略快照** + 各 candidate 从自己 accumulator 推导 | 对抗评审：`generationHedgeEnabled` 默认 `true`，落败 candidate 会覆盖胜出者的裁决。共享可变槽位与并发 candidate 天然冲突 |
| 「保证只发一个终态」 | 「保证一个**完整**终止符」——无条件补合成 `message_stop` | 真 SDK 探针：合成 `end_turn` 不给终止符时 `@anthropic-ai/sdk` 抛 `stream ended without producing a Message with role=assistant` |
| `{thinking_tokens}` 未知时回落 `output_tokens` | **未知就是 `undefined`，渲染 `unknown`** | `bio` 样本只有一个 thinking 块，却 `output_tokens=25848` vs `thinking_tokens=25636`（差 212） |

## 4. 留在项目里的可复现资产

结论会过期，探针不会：

- `exp/refusal-samples/FINDINGS.md` —— 三个真实样本的一手字节 + 取证方法（含全库扫描的正样本对照记录）。**写任何 refusal 测试的 fixture 来源**。
- `tests/anthropic/refusal-default-oracle.unit.test.ts` —— 默认值 oracle。**它的第三条不提任何模式名**，从真实 ctx 冻结的策略走到可观测 wire；翻默认值时它会红。
- `tests/anthropic/refusal-terminal-invariants.unit.test.ts` —— exactly-one-COMPLETE-terminus 转移表逐格 + 两条正控。
- `tests/e2e-client/anthropic-cli.e2e.test.ts` —— **双轮 session oracle**（真 CLI，`--session-id` + `--resume`）。这是「不中断对话轮次」这个目标本身的唯一直接判据，R1 收口必须复用它。
- `tests/routes/reverse-contentless-refusal.it.test.ts` —— 三条 reverse 腿的裁决口径守卫，R1 会在它之上扩展。

## 5. 编排权

**本轮工作在此完结，编排权交回用户。** 剩余项没有正在推进的 agent，也没有约定的下一位负责人——R1/R2/R3 各自独立，谁接手都要先按 §0 重新确认状态。

## 6. 数字（实测，注明测点）

测于 `1bee331d`：`bun scripts/parallel-test.ts unit it http` → **6634 tests / 6634 pass / 0 fail**。

> ⚠️ 这个数字会随 master 快速漂移，**不要引用它当基线**——接手时自己跑一遍。特别注意：2026-07-28 起 history-search 的 native 产物默认不构建，依赖它的测试走 `skipIf`（有产物真跑、没有显式 skip、**绝不红**）。若你看到这批红了，那是真回归，不是环境问题。

## 7. 未做且**未**记档的事：无

复审的 MED-4/5 与 LOW-1/2/3/5 在 §2 R2/R4，R1/R3 在 `deferred-backlog.md`，LOW-4 已消解并在 §2 说明。本轮没有「知道但没写下来」的项。

# 交接：contentless refusal 抑制 —— 剩余工作

> 状态测于 **`241a7b86`**（2026-07-28）。主体已合并回 master（`d108366b`），**本文只交接未做的部分**。
> **修订记录**：初版（`6dc446d7`）把 R1 的范围写错了——说六格 wire 都没抑制。补 oracle 实测后翻转：流式三格已经在抑制，缺口只有非流式三格。§2 R1 已重写，原文的错误与原因保留在那条的引言里。
> 已完成部分的设计与结论**不在本文复述**，见 §1 必读清单——本文写指针，不写副本。

## 0. Kick-off 提示词（可直接粘进新会话）

```
接手 copilot-api-js 的 contentless refusal 抑制的剩余工作。

先按顺序读，别跳：
1. docs/DESIGN.md 的「活的架构现状」表 —— 项目强制的接手入口。当前活/wip/bypass/退役路径以它为准，
   不读会把已退役的路径当活的（本交接件的作者就犯过这个错）
2. docs/refusal-recovery.md —— refusal 的现状契约（活文档）
3. docs/plan/2026-07-28-refusal-suppression-handover.md —— 本交接件，剩余项与判据
4. R1 的实际代码 owner（做 R1 才读，别提前读）：
   src/lib/pipeline/driver.ts:1562 runResponseWhole   ← transformWhole 的唯一驱动点，也是 R1 的核心
   src/routes/{chat-completions,responses,gemini}/handler-v4.ts  ← 三条 route 的非流式 render（少调了上面那个）
   src/lib/codec/anthropic/response-rewrite-adapters.ts          ← 四个 transformWhole 钩子在这
   tests/routes/reverse-refusal-default-wire.it.test.ts          ← 客户端实收 wire 的六格 oracle（R1 要翻它三条）
   tests/routes/reverse-contentless-refusal.it.test.ts           ← 裁决口径六格守卫（mode 钉不住，见交接件 R1 陷阱）

按需查（不要当必读，会浪费你的时间）：
- docs/spec/...-review-merged-state.md —— 第四轮复审快照。要理解某条发现的来龙去脉时查；
  它的 file:line 会漂，别照抄
- exp/refusal-samples/FINDINGS.md —— 写 fixture 或做 R3 实验时查

动手前先跑这组检查确认交接件没过期。**注意怎么读输出**：只有交接提交自己 = 无功能变化；
出现 src/ 下的提交 = 有人动过，逐条重验交接件的状态断言。

  git rev-parse --short HEAD
  git log --oneline 6dc446d7..HEAD -- \
    src/lib/anthropic src/lib/openai/translate src/lib/pipeline/reverse-terminal.ts \
    src/routes tests/routes/reverse-contentless-refusal.it.test.ts \
    tests/openai tests/e2e-client docs/refusal-recovery.md docs/todo/deferred-backlog.md
  git branch -a --format='%(refname:short) %(subject)' | rg -i 'refusal|fallback|suppression'

剩余项按 R1 → R2 → R3 顺序做，R1 是唯一影响用户可观测行为的。每项的判据、触点、
以及「为什么之前没做」都在交接件 §2。R1 有一条会浪费你半小时的陷阱写在那一条末尾，
动手前先看那一段。
```

## 1. 必读清单（附为什么必读）

**必读**（顺序即依赖顺序）：

| 文件 | 为什么必读 |
|---|---|
| [docs/DESIGN.md](../DESIGN.md)「活的架构现状」 | **项目强制的接手入口**。当前活/wip/bypass/退役路径以它为准。跳过它会把已退役的路径当活的——本交接件初版就因为没列它而继续引用了一条退役前提 |
| [docs/refusal-recovery.md](../refusal-recovery.md) | refusal 的**现状契约**：默认值、三模式语义、exactly-one-COMPLETE-terminus、冻结策略与 hedge 的关系。不读会重新引入已修掉的问题 |
| 本交接件 | 剩余项、判据、差异表 |

**做 R1 时才读**（提前读只是浪费）——这些是当前真正的代码 owner，不要照抄旧评审里的 `file:line`（会漂）：

| 文件 | 它拥有什么 |
|---|---|
| `src/lib/pipeline/reverse-terminal.ts` | reverse 三条腿**共享**的终态分类器（模块注释自称「让三条 pump 不会漂移」） |
| `src/lib/openai/translate/anthropic-to-{cc,responses}{,-stream}.ts` | 四个 Anthropic→目标协议翻译器（whole + stream 各二） |
| `src/routes/{chat-completions,responses,gemini}/handler-v4.ts` | 三条 route 的 reverse render/pump 与 settle 点 |
| `tests/routes/reverse-contentless-refusal.it.test.ts` | 现有的裁决口径守卫，R1 在它之上扩展 |

**按需查**（不是必读）：

| 文件 | 什么时候查 |
|---|---|
| [第四轮合并态复审](../spec/2026-07-27-refusal-diagnostics-and-typing-review-merged-state.md) | 想知道某条剩余项**为什么被判为问题**时。它是快照，`file:line` 会漂，别照抄 |
| [exp/refusal-samples/FINDINGS.md](../../exp/refusal-samples/FINDINGS.md) | 写 fixture 或做 R3 实验时。三个真实样本的一手字节（category `null`/`bio`/`cyber`） |
| [设计源 spec](../spec/2026-07-27-refusal-diagnostics-and-typing.md) | **做 R3 前读它的 §3.2**（未采纳方案与理由），否则会重新论证一遍 |
| [已完成部分的执行记录](2026-07-28-refusal-suppression-remaining-tasks.md) | 只在「当时为什么那样做」时查 |

**高发区提醒**：`src/lib/anthropic/refusal-detail.ts` / `refusal-policy.ts` 是**零依赖叶子**——存在的唯一理由是不把 rewrite 图拖进 19 模块 core SCC。往里加 import 会被 `tests/architecture/circular-deps-ratchet.unit.test.ts` 咬。本轮踩过两次。

## 2. 剩余项

> **这一节的状态字段谁说了算。** 每条的「已核实仍未做」都是**测于 `1bee331d` 的快照**，交接件**不持有**这个状态——`docs/todo/deferred-backlog.md`（R1/R3）与 git 历史才持有。两边打架时**信 backlog 与代码，不信本文件**。接手第一件事就是按 §0 用命令重新核一遍，别照抄。
>
> 本节相对 backlog 的**增量**（也是它存在的理由）只有三类：**为什么当初没做**、**踩过的坑与反方向警告**（R4 里那些「别改错方向」）、**收口判据**。这三类是判断，不是状态，不会因为别人推进而失效。

### R1 · reverse `@messages` **非流式**三格没跑 whole-response 改写链（唯一影响用户可观测行为的一项）

> **本条在 2026-07-28 被实测重定过范围，交接件初版写错了。** 初版说「六格 wire 都没抑制、默认 `end_turn` 对 reverse 腿不产生任何抑制效果」——**流式三格是错的**。它当时没有任何 oracle 支撑：仓库里唯一相关的测试钉的是 passthrough 模式且只断裁决，从不看 wire。补上 oracle 后结论翻转。这条经历本身值得读：`appliesTo` 命中不等于链被驱动，而「没人测过」的地方最容易把推断写成事实。

**已核实（`d5f33395` 起有 oracle）**：`tests/routes/reverse-refusal-default-wire.it.test.ts` 逐格断言客户端实收字节。

- **流式三格：已经在抑制，不用做。** per-frame 改写链的门是 `targetEndpoint === /v1/messages`，reverse 腿正好命中，所以 Anthropic 帧在 reverse 翻译器看到它之前就被改写了，各目标协议白拿一个正常轮。实测：CC `finish_reason:"stop"` + end_turn 正文 + `[DONE]`；Gemini `finishReason:"STOP"` + 文本 part；Responses `response.completed`。**这是要守住的行为**，别在做 R1 时把它改坏。
- **非流式三格：没有抑制。** 客户端实收 CC `finish_reason:"content_filter"`+`content:null` / Responses `status:"incomplete"`+`incomplete_details.reason:"refusal"` / Gemini `finishReason:"SAFETY"`+空 parts。这三条腿上客户端的对话轮次仍会被打断。
- **根因是少调了一次，不是三套协议呈现逻辑没写。** whole-response 改写链在 `driver.runResponseWhole`，它是 `transformWhole` 的**唯一**驱动点（`src/lib/pipeline/driver.ts:1565`），而它在生产代码里**只有一个调用点**——直连 Anthropic handler。三条 reverse 非流式路径只调 `driver.runResponseNonStreaming`（纯 render）。
- **因此波及面不止 refusal。** `recover-tool-call` / `tool-input-decode` / `server-tool-filter` / `recover-refusal` 四个 `transformWhole` 钩子在 reverse 非流式腿上**全部落空**（`appliesTo` 都命中，只是链没被驱动）。refusal 只是被观测到的那一个，另外三个**目前没有任何 oracle**——做 R1 时一并建。
- **若做需改什么**：① reverse 非流式路径在翻成目标协议**之前**先对 Anthropic body 跑 `runResponseWhole`（流式腿等价于已经这么做了，所以这是**对齐**）；② 别动 settle 判据的读取对象——见 §2 R4 的 LOW-5，`isRefusal` 读**链前** upstream-original 正是抑制后 settlement 正确的原因；③ feature 从写死的 `refusal-passthrough` 改成实际 mode；④ 把 wire 测试的三条非流式期望翻成与流式一致（**它们就是本任务的落地信号**）；⑤ 补至少一条同 session 后续轮可继续的真实客户端测试。
- **判据**：三条非流式腿在默认配置下客户端拿到正常完成轮，且同 session 下一轮能继续。**别只用状态机单测收口**——真 SDK/CLI oracle 才能裁决「轮次会不会断」。
- **陷阱（会浪费你半小时）**：**这一层钉不住 refusal 模式**。仓库根 `config.yaml` 写着 `refusal_sse_rewrite: end_turn`，而路由每请求调 `applyConfigToState()`，所以 `setStateForTests({refusalSseRewrite})` 会在请求级 policy 冻结**之前**被覆盖掉（已在冻结点插桩确认）。要给这一层做 mutation control，破坏生产代码（如 `refusalRewrite.appliesTo → false`），别去翻状态。
- **完整记录**：`docs/todo/deferred-backlog.md`。

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
| LOW-1 re-export 可绕过零依赖叶子 | `recover-refusal.ts` 有 **5 条** `export`/`export type` 转出两个叶子的符号（自己数：`rg -n "^export( type)? \{" src/lib/anthropic/recover-refusal.ts`）。`circular-deps-ratchet` 只在真成环时才咬，一条新边可能要等第二条才暴露 | 别只加注释。要守的**不变量**是：`src/lib/**` 的消费者不得经 `recover-refusal.ts` 取用 `refusal-policy`/`refusal-detail` 拥有的类型与 primitive。优先删跨 owner re-export + 加架构守卫 |
| LOW-2 degradation `target` 无 gemini | `refusal-detail.ts:91` 是 `"openai-cc" \| "openai-responses"`；Gemini 委托 CC codec，marker 记成 `openai-cc`，按 target 分组永远看不到 Gemini | 加 `"gemini"`，或拆成 `hop` + `clientFormat` |
| LOW-3 残留 `thinking-only` 措辞 | `src/` 下 8 处，**但不是同类，别全仓替换**：`context/types.ts` / `context/request.ts` / `pipeline/rewrite-registry.ts` 三处是**把它当正向名称用**，该改；`recover-refusal.ts` 里 5 处是在解释「为什么**不能**叫 thinking-only」，是**承重反例注释**，删掉会丢掉防旧名回归的理由 | 只改前三处 |
| LOW-5 非流式判据可读性 | **注意别改错方向**：`response` 是**链前**的 upstream-original，`finalResponse` 才是链后 client-facing（`runResponseWhole` 返回新对象、不原地改）——`isRefusal` 读 `response` 正是它能识别抑制前 refusal 的原因。缺陷只是两个名字都没表达阶段 | 重命名为 `upstreamResponse` / `clientResponseBody` + 注明 rewrite 是 immutable。**绝不能**把 `isRefusal` 改成读 `finalResponse`，那会真的破坏抑制后的 settlement |

**LOW-4 结构上已证伪原假设，但尚缺行为回归探针**：复审担心 continuation 复用同一 accumulator 会把上一轮的 `stopDetails` 带进下一轮终态。我查了 `driver.ts`：continuation 走 `coordinator.runContinuation(...)` 返回**新 candidate**，而 session/accumulator 是 per-candidate 创建的（`driver.ts:531`）。**证据指向原假设不成立，但全仓没有任何测试断言「上一 candidate 的 `stopDetails` 不进入 continuation candidate」**，而 `stopDetails` 本身仍是只写不清——将来 candidate/session owner 被重构时这个结构性证明会悄悄失效。补一条探针（第一 candidate 写入 `stopDetails` → 触发 continuation → 断言第二 candidate 的 snapshot 里是 `undefined`）之后才能标为已消解。

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
| 交接件初版：reverse 六格 wire 都没抑制 | **流式三格已经在抑制**，缺口只有非流式三格 | 补 oracle 实测（`reverse-refusal-default-wire.it.test.ts`）：CC `stop`+正文+`[DONE]`、Gemini `STOP`+文本 part、Responses `response.completed`。原结论从未有测试支撑，是从「reverse codec 先翻译」推断出来的 |
| R1 = 在三种协议里各实现一遍呈现策略 | R1 = **补一次 `runResponseWhole` 调用** | `transformWhole` 的唯一驱动点只有一个生产调用点（直连 Anthropic handler）。顺带发现另外三个 whole 钩子在 reverse 非流式腿上也全落空 |

## 4. 留在项目里的可复现资产

结论会过期，探针不会：

- `exp/refusal-samples/FINDINGS.md` —— 三个真实样本的一手字节 + 取证方法（含全库扫描的正样本对照记录）。**写任何 refusal 测试的 fixture 来源**。
- `tests/anthropic/refusal-default-oracle.unit.test.ts` —— 默认值 oracle。**它的第三条不提任何模式名**，从真实 ctx 冻结的策略走到可观测 wire；翻默认值时它会红。
- `tests/anthropic/refusal-terminal-invariants.unit.test.ts` —— exactly-one-COMPLETE-terminus 转移表逐格 + 两条正控。
- `tests/e2e-client/anthropic-cli.e2e.test.ts` —— **双轮 session oracle**（真 CLI，`--session-id` + `--resume`）。这是「不中断对话轮次」这个目标本身的唯一直接判据，R1 收口必须复用它。
- `tests/routes/reverse-contentless-refusal.it.test.ts` —— reverse 六格的**裁决口径**守卫（failed / upstreamSucceeded / feature）。注意它的 refusal 模式钉不住，见 §2 R1 陷阱。
- `tests/routes/reverse-refusal-default-wire.it.test.ts` —— reverse 六格的**客户端实收 wire** oracle，默认配置下逐格断言。**R1 的落地信号就是它的三条非流式期望被翻过来**；它也是推翻交接件初版结论的那个测试。

## 5. 编排权

**本轮工作在此完结，编排权交回用户。** **未发现仓库可见的在途实现**（`git log --all` + 全 branch 检索无相关功能提交，相关 feature branch 停在已合并的 `d108366b`）——注意这只能证明「仓库里看不到」，证明不了「没有任何外部会话在想这件事」。也没有约定的下一位负责人——R1/R2/R3 各自独立，谁接手都要先按 §0 重新确认状态。

## 6. 数字（实测，注明测点）

测于 `241a7b86`：`bun run test:backend` → **6645 tests / 6645 pass / 0 fail**（36s，16 分片）。

> ⚠️ 这个数字会随 master 快速漂移，**不要引用它当基线**——接手时自己跑一遍。特别注意：2026-07-28 起 history-search 的 native 产物默认不构建，依赖它的测试走 `skipIf`（有产物真跑、没有显式 skip、**绝不红**）。若你看到这批红了，那是真回归，不是环境问题。

## 7. 未做且**未**记档的事：无

复审的 MED-4/5 与 LOW-1/2/3/5 在 §2 R2/R4，R1/R3 在 `deferred-backlog.md`，LOW-4 已消解并在 §2 说明。本轮没有「知道但没写下来」的项。

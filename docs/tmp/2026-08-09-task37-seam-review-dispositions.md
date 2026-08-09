# Task 37 合并态复审 —— 主会话对评审发现的裁决与独立取证

- 基线：`638f6f3c898f7562fc086bfb2c5f1f4b04a5b5ad`
- 视角 B 报告：`docs/tmp/2026-08-09-task37-seam-review-drift.md`（`gpt-souls:reviewer`）
- 视角 A 报告：`docs/tmp/2026-08-09-task37-seam-review-invariants.md`（`verifier`，进行中）
- 本文件只记**主会话亲自复核的结论**，不复述评审原文。

## D1 —— 判定：不成立（归属误判），撤销其 BLOCKER

视角 B 主张「Task 4 的 owner migration 已部分提前落地，形成混合所有权」。**四条独立证据都指向相反结论。**

1. **Task 4 的交付物一项都不存在。** 冻结计划 `plan-1-sse-and-delivery-foundation.md` 的 Task 4 节列了四项：`consume(outcome, adapter)`、`runSyntheticResponse`、新建 `delivery/synthetic.ts`、删除 `writeWinnerFrames`/`writeWinnerFrame`。实测：前三项 grep 全仓为空、`src/lib/pipeline/delivery/` 下无 `synthetic.ts`；第四项相反——`writeWinnerFrames` 与 `writeWinnerFrame` 仍在 `src/lib/pipeline/driver.ts:1215,1219`，调用点 `:1117,1129,1146`。
2. **它引为证据的基础设施早于这份计划。** `src/lib/pipeline/delivery/session.ts` 首次出现于 `786929b5`（2026-07-17），`wireAllocationPort` 引入于 `1c40f768`/`79700269`/`ebc863af`（均 2026-08-02），`owner-failure.ts` 于 `6333d800`（2026-08-03）。而本计划目录日期为 **2026-08-07**。
3. **计划自己说了它是既有物。** Task 4 清单原文：「在现有 session 内增加 candidate-local staging／outcome consumption；**复用** serializer、wire state、**allocation port**、terminal fence」。要复用的东西当然先于它存在。
4. **计划期内零新增。** `git log --since=2026-08-07 -S 'wireAllocationPort' -- src/` 为空。

**该发现自身还有内部张力**：它把「owner 外 write helper 仍存在」列为「迁移了一半」的证据，而那恰恰是 Task 4 **尚未执行**的定义性状态——Task 4 的任务就是删掉它们。

**结论**：I8（未提前 Task 4）在 `638f6f3c` 上成立。D1 不构成阶段边界违规，不阻塞。

## D2 —— 判定：成立，且比所报更重；升为 BLOCKER

视角 B 报「outer JSON classifier 被静默遮蔽，形成休眠的第二 classifier」，定级 MAJOR，并建议**删除** handler 传入的外层谓词。**机械部分成立，但性质判轻了，而建议的修法方向是反的。**

### 遮蔽机制（逐层复核）

- `src/lib/pipeline/driver.ts:988`：`const merged = { ...outer, ...candidate } as T`。其后显式重组的只有 `onUpstreamFrame`、`onFinishResolved`、`onRenderedFrame`、`sawMessageStop`、`sawUpstreamError` 五个字段（`:991-1015`）。**`commitBoundaries` 不在其中**，故 candidate 的值直接胜出。
- `src/lib/pipeline/generation/candidate-response-session.ts:227`：`...(adapter.deliveryMode === "unit" && { commitBoundaries: (frame) => completedBoundaryFrames.has(frame) })`。
- `src/lib/pipeline/delivery/adapters/anthropic.ts:33`：Anthropic adapter 是 `deliveryMode: "unit"` → 该字段确实被设 → 遮蔽在生产路径上真实发生。
- `src/routes/messages/handler-v4.ts:1875` 仍传 `commitBoundaries: anthropicCommitBoundaries`，其上方注释（`:1873-1874`）写的是「candidate session owns accumulators/diagnostics but **must not shadow this outer gate**」——**代码与它自己声明的契约矛盾**。

### 为什么它不是等价替换（视角 B 未查到的部分）

`completedBoundaryFrames` 只在 `outcome.kind === "complete-unit"` 时收帧（`candidate-response-session.ts:127`）。而被遮蔽的外层谓词把 `content_block_stop` **和 `error`** 都算 commit 边界——后者的依据写在 `src/lib/codec/anthropic/commit-boundaries.ts` 的 docstring 里：spec §5.3 M1，「上游终态 error 帧⋯⋯H2 终态必是 commit 边界」。

实测（`exp/task37-anthropic-error-boundary/probe-classify.ts`，跑在 `638f6f3c`）：

| 帧 | 外层 `anthropicCommitBoundaries` | `adapter.classify().kind` | 能否进 `completedBoundaryFrames` |
| --- | --- | --- | --- |
| `content_block_stop` | `true` | `unit-close` | 能 |
| `error` | `true` | `protocol-error` (`semantic=unexpected-frame`) | **不能**（非 `unit-close`） |

**第二个信号也丢了**：`isUpstreamFailure`（`candidate-response-session.ts:268-270`）只含 `terminal-failure` 与 `adapter-exception`，**不含 `unexpected-frame`**，所以 `sawUpstreamError` 也不因该帧触发。

**最尖锐的一刀**（`probe-roundtrip.ts`）：把 adapter 自己 `renderError()` 产出的帧喂回它自己的 `classify()`，得到的同样是 `unexpected-frame`——**这个 adapter 认不出自己写出的错误帧**。

### 同族不对称，指出了修法

姊妹适配器 `src/lib/pipeline/delivery/adapters/responses.ts:81-83` **有** `case "error":`，与 `response.failed` 并列映射为 `{ kind: "response-terminal", terminal: { semantic: "failed" } }`；该 outcome 会让 candidate 的 `sawFailure` 置位、`sawUpstreamError` 触发。Anthropic adapter 没有这个分支。而 Responses 的 legacy 谓词 docstring 里写着这两条信号是**互为镜像**的设计（「Mirrors the buffered sink's `sawUpstreamError` gate」）。

**因此正确修法是补上 Anthropic adapter 缺失的 `error` 分支**，让 grammar 投影真能推导出同一个边界集合；而不是像视角 B 建议的那样删掉外层谓词——那会把这个偏差固化成既定行为，并悄悄丢掉一条 spec 规则。

## 附带发现 —— `isResponsesCommitBoundary` 已无生产消费者

`src/lib/codec/openai-responses/commit-boundaries.ts` 的 `isResponsesCommitBoundary` 在 `src/` 下**没有任何静态引用**，只有两个测试文件导入它（`tests/responses/heartbeat-survives-item-commit.it.test.ts:23`、`tests/responses/responses-commit-boundaries.unit.test.ts:24`）。它是 D2 同一类形态的第二个实例，症状相反：Anthropic 是「仍在传、被盖掉」，Responses 是「已不再传、但函数与专属测试套件都还在」，读代码的人会以为它仍然生效。

⚠️ **不据此建议删除。** 本项目明令不得以「无消费者」为名擅自删代码；且它的两个测试可能守着别的不变量。此处只登记事实，处置交裁决。**「无引用」的口径是静态 grep（`src/`、`tests/`，`*.ts`），不覆盖动态引用。**

## 待办

1. ~~等视角 A 交付 I4–I9、I11。~~ 已交付：I2–I8、I10、I11 均 HOLDS 且各带实测变异正控；**I9 VIOLATED**（与视角 B 的 D2 同源，但它做出了真实 HTTP 端到端复现）；另报 I1 一条 MAJOR 判据缺口。
2. 见下「整改记录」。
3. 修完恢复两个视角复审（`SendMessage`，不重派），闭合条件为 0 blocker / 0 major。

---

# 整改记录

## 已修：Anthropic adapter 缺 `error` 分支（I9 / D2 的根因）

**两个独立视角收敛到同一根因**，且视角 A 把它推到了用户可观察层：真实 `createFullTestApp()` → `/v1/messages`、`protect_streaming_generation=on`，上游发 `message_start` 后紧跟 `event: error`、无 `message_stop` —— 驱动把这个**上游终态决策**误判成传输层截断，`upstreamCalls` 期望 `1`、实测 **`4`**（1 次原始 + 3 次重试耗尽 `maxRetries`）。主会话独立复跑确认：`Expected: 1, Received: 4`。

**这违反了两处白纸黑字的承诺**：spec `docs/spec/2026-07-11-block-level-buffered-retry.md:152`（H2 error 帧「须在 commitBoundaries 与重试判定中显式纳入」），以及 `src/routes/messages/handler-v4.ts:1895-1897` 自己的注释（「lets the buffered sink COMMIT it ... instead of wastefully retrying it as a truncation」）。

**修法选择（两个候选，选了后者）**：

- ① 在 `mergeCandidateResponseOpts` 里补 `commitBoundaries` 的 OR 组合重组。**未采纳**——那会让 handler 层的 JSON classifier 重新生效，直接违反 Task 3 已冻结的契约「`DeliveryProtocolAdapter.classify` is the only wire classifier」与「compatibility projection 只从 grammar outcome／terminal state 派生」。
- ② **已采纳**：给 `src/lib/pipeline/delivery/adapters/anthropic.ts` 的 `classify()` 补 `case "error"`，映射为 `{ kind: "response-terminal", terminal: { semantic: "failed" } }`。这与姊妹适配器 `adapters/responses.ts:81-83` 完全同形（那里 `error` 与 `response.failed` 并列），把修复放在**两条信号共同的基座**上：该 outcome 同时让 `sawTerminal` 与 `sawFailure` 置位，`sawUpstreamError` 因此触发。

**证据**：

| 判据 | 修复前 | 修复后 |
| --- | --- | --- |
| `tests/pipeline/i9-h2-buffered-probe.http.test.ts`（视角 A 所写） | `0 pass / 1 fail`，`Expected: 1, Received: 4` | `1 pass / 0 fail` |
| `tests/pipeline/h2-committed-block-delivery.http.test.ts`（主会话新增，见下） | —— | `1 pass / 0 fail` |
| `tests/{anthropic,pipeline,responses,chat-completions}/` 全量 | —— | `2886 pass / 0 fail`（292 文件） |
| `bun run typecheck` / `bun run lint:all` | —— | 均 exit 0 |

**测试的作者与修复的作者是不同方**：红测由视角 A 写，修复由主会话做，避免了同源自证。

## 新增的判别性判据：已提交内容块必须活过终态错误

视角 A 的探针只覆盖「error 紧跟 message_start」这一种形状。**一个只修好重试、却把缓冲区连同已提交内容一起丢掉的实现，能通过那条探针。** 因此补 `tests/pipeline/h2-committed-block-delivery.http.test.ts`：上游发 `message_start` → 一个**完整**内容块（start/delta/stop）→ `event: error`，断言客户端既收到 `committed-prefix` 文本与 `content_block_stop`，也收到 `error`，且 `upstreamCalls === 1`。这一条钉的是 spec §5.3 M1 里「commitBoundaries」那一半，与视角 A 钉的「重试判定」那一半互补。

## 仍未处置，交复审裁决（不由我自判）

1. **`commitBoundaries` 在 `mergeCandidateResponseOpts` 里依然不被重组。** 本次修复绕过了它（改基座而非改 merge），所以 I9 的可观察缺陷消失了，但**遮蔽机制本身还在**：今后任何一个外层 `commitBoundaries` 仍会被 candidate 静默盖掉，且不会有任何报错。
2. **`src/routes/messages/handler-v4.ts:1875` 传入的 `anthropicCommitBoundaries` 现在是彻底的死参数**，而它上方 `:1873-1874` 的注释仍写着「must not shadow this outer gate」——**注释与行为相反**。是删掉传参与注释、还是让 merge 尊重外层，属于契约决定，需裁决。
3. **`isResponsesCommitBoundary` 无生产消费者**（见上文附带发现）。
4. **视角 A 报的 I1 MAJOR 判据缺口**：没有任何测试断言传给 History capture 的对象仍是 rich `ParsedSseFrame`；若有人在 `response-processor.ts` 的上游捕获前插入一次投影，**现存测试全不会红**。这不是当前缺陷，是判据缺口，建议补一条断言。

## 基线维护说明（避免下一个人踩坑）

新增两个测试文件让 `tests/infra/entry-evidence-schema.unit.test.ts` 的「tracks the current backend discovery population」变红。**只改了 `baseline.files`（+2 行），没有整份重建。** 理由：本工作树**已构建** native history-search 产物，整份重建会连 `allowed_skipped` 一起重写，把基线里 34 条 `native-unavailable` 从 master 一贯假设的「产物缺席」环境**静默翻到「产物存在」环境**，使所有没构建产物的树反过来变红。该潜伏问题已单独记入 `docs/todo/deferred-backlog.md`。

---

# 第二轮：复审、裁决与再整改

## D1 —— 已由未卷入的第三方裁决

争议交 `gpt-souls:arbiter`（未参与此前任何一方评审）。**裁决：乙方成立，甲方 BLOCKER 撤销**，理由与本文件第一轮的四条证据一致。甲方随后在自己的报告里接受该反证并撤回。

裁决者另给一条细分，值得照录：甲方**准确识别了**「新 owner 接线与 owner 外 write helper 并存」这个混合写路径，只是把归属判错了。该结构问题定级 **Major、非当前 blocker**，且**已由冻结计划的 Task 4 记录在案，不应重复建项、也不应描述成「提前实施」**。

## 第一轮修复被判不完整 —— 两个新 BLOCKER，都成立

我第一轮只修了 adapter 缺 `case "error"`，复审证明那还差两块，**每块都有独立的端到端复现，两种形状都仍然重试四次**。

### D4：修复寄生在一个可关闭的配置上

adapter 的分类键只读 canonical payload 的 `type`。Anthropic 的 error 帧实际以 `event: error` 到达、body 只有 `{ error: {...} }`；那个顶层 `type` 是**前置的 canonical error rewrite** 补上的，而它是用户可关的设置（关掉时是配置明确支持的 byte-identical passthrough）。于是 `errorShapingEnabled=false` 时 adapter 又看回 `unexpected-frame`。

**修法**：`frameType` 在 payload 未声明 `type` 时回落到 SSE `event` 行。**这是加法**——任何已带 payload `type` 的帧分类结果与从前逐字节相同；姊妹的 `adapters/responses.ts` 本来就先读 event 行。

### D5：grammar 把「上游中途失败」误判成协议违规

`grammar.ts` 的 `acceptTerminal` 对**任何**在 open unit 期间到达的终态一视同仁：丢弃半块，并把终态**整个替换成** `terminal-with-open-unit` 错误——`response-terminal` outcome 根本不发出。对**成功**终态这是对的（生产者声称响应结束，却有块没关）。对**失败**终态不对：上游随时可能死，包括块进行到一半时；把它压成协议错误，恰好毁掉重试判定唯一需要的那个事实，因为 `terminal-with-open-unit` 不算上游失败。

**修法**：按 `terminal.semantic` 分流。两条冻结规则同时满足——半块照旧丢弃（不泄漏部分块），失败仍以终态身份浮现。

**先查了它守什么再改**：`delivery-grammar.unit.test.ts:103-106` 的既有断言用的是 `semantic: "complete"`，走的仍是错误分支、仍然通过。**这是加法，不是放宽既有守卫。**

## D3 —— 我自己写的判据是 false-green，已改正声称而非粉饰

复审实测：把 adapter 的 `case "error"` 删掉，我那条 `h2-committed-block-delivery` **照样绿**。原因是结构性的——前面的 `content_block_stop` 已经 flush 了块，而字节一旦提交，重试闸门无论 error 如何分类都拒绝重试，`upstreamCalls` 恒为 1。

**处置：不把它拧强，而是改正它的声称。** 头部现在写明它钉住什么、以及它**判别不了**哪两个机制，并注明两条非声称都是**实测的、不是推断的**。

## 我在这一轮自己犯的错（由我自己的正控抓到）

我把 D4 的控制点**加错了地方**——parameterize 到了 `h2-committed-block-delivery` 上。跑正控时发现：移除 event 行回落后它**两格都还是绿的**。这正是我上一段刚写下的结论（该形状结构上无法判别任何 error 分类机制），我却在同一轮里又踩了一次。判据已挪到「无前置内容」那条探针上（重试闸门仍开），并给两格独立 session id 以免互读 history。

**教训形态**：「把一个判据参数化」看起来像增强，但**参数化一个本就无鉴别力的形状，只会得到两格绿，而不是一格更强的判据**。

## 三处修复的变异正控（全部实测，逐条复原）

每次变异后先 `git diff` 冻结成 patch，`git apply --reverse --check` 通过后再反向应用，复原后确认 `git diff -- src/` 为空。

| 变异 | 目标判据 | 结果 |
| --- | --- | --- |
| adapter `case "error"` 停用 | `i9-h2-buffered-probe` | `Expected: 1, Received: 4` |
| event 行回落移除 | `i9-h2-buffered-probe`（`errorShapingEnabled=false` 那格） | `Expected: 1, Received: 4` |
| grammar 的 failed-terminal 分支停用 | `i9-followup-midblock-error` | `Expected: 1, Received: 4` |

门禁：`16 shards · 7652 tests · 7652 pass · 0 fail · 9 skipped`，exit 0，零 crashed shard；typecheck 与 `lint:all` 均 exit 0。

## 仍未处置，继续挂账

第一轮列的四条**一条都没有被本轮解决**，原样有效：`mergeCandidateResponseOpts` 仍不重组 `commitBoundaries`；handler 那个死参数与自相矛盾的注释；`isResponsesCommitBoundary` 无生产消费者；I1 的判据缺口。另加两条：

5. **视角 B 报的 D6（MAJOR）**：两条新测试只断言 `state=failed`，没有证明 History 保留了**真实的 upstream error 因果**、排除了被重标成 truncation。我没有补这条断言。
6. **裁决者判定的混合写路径 Major**：归属属冻结计划的 Task 4，不另建项，但收口 Task 4 时必须一次性收敛。



# Task 37 合并态复审——视角 B：接缝漂移与消费者第一人称走查

## 评审范围与证据

- 目标：冻结提交 `638f6f3c898f7562fc086bfb2c5f1f4b04a5b5ad` 的 Task 1b × Task 3 合并态，专查接缝漂移、消费者路径、A/C 类复发、outcome 丢弃与 Task 4 越界；不重复视角 A 的逐条 I1–I11 证伪。
- 已读：四类生产入口 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/routes/{messages,chat-completions,responses,gemini}`，以及 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/lib/pipeline/{driver.ts,generation/candidate-response-session.ts,generation/candidate-race.ts,stream/response-processor.ts,delivery/*}`、transport parser/projection、计划与集成进度。
- 已执行：callback／merge／classifier／outcome／Task 4 marker 全仓定向搜索；`bun test tests/pipeline/response-processor.unit.test.ts tests/pipeline/candidate-response-session.unit.test.ts tests/pipeline/delivery-adapters.unit.test.ts` 为 29 pass／0 fail；`bun test tests/pipeline/generation-runtime-baseline.http.test.ts tests/pipeline/hooks/driver-provenance.unit.test.ts` 为 15 pass／0 fail。数字口径均为该命令在本轮工作树的一次运行，未作第二原理交叉计数，因此只作为选择器执行成功的辅助证据，不作为覆盖完备性的证明。
- 工具限制：运行时隔离护栏拒绝对子工作树执行 `git rev-parse`／`git status`，即使按派发件写绝对目录与 HEAD 断言也被拦截。因此 Bash 证据由每次显式 `cd /home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2` 约束目录，但无法把 HEAD 断言嵌入同一调用；目标文件内容则均从该绝对路径读取。最终 clean 状态同样无法用 git 命令验证；本评审未修改该工作树。

## 事实性发现

### D1

- **所在路径或形态：** Task 4 越界——owner migration 已在 Task 3 合并态之后被提前实施。
- **严重级别：BLOCKER**
- **证据：** 冻结计划 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/docs/plan/2026-08-07-mandatory-block-delivery-h2-observability/plan-1-sse-and-delivery-foundation.md:72-93` 把 `DownstreamDeliverySession` 升级、`runResponseBufferedSink` 经 owner 消费 grammar outcomes、删除 owner 外 `writeWinnerFrames`／`writeWinnerFrame` 明确定义为 Task 4；当前 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/lib/pipeline/driver.ts:1109-1119,1125-1149,1208-1221,1314-1324,1410-1420` 已把 allocation port／delivery session owner 接进 live、hedge 与 buffered 路径，且仍保留 owner 外 `writeWinnerFrames`／`writeWinnerFrame`。`/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/routes/messages/handler-v4.ts:1920-1922,1965-1975,2280-2282,2317-2318` 也把 `wireAllocationPort` 与 owner failure settlement 接进生产 pump。这不是单纯后续无关重构，而是计划列出的 Task 4 owner 接线已经部分落地。
- **接手方会做出的错误动作：** 下一位实施者若按进度账本“未提前 Task 4”继续，会在已经迁移过一半的 owner 接缝上再次执行 Task 4，或者误把 `writeWinnerFrames` 等旧旁路当成 Task 3 合法兼容层保留，造成双 owner／双写入口，无法按冻结阶段边界判断哪些路径应由谁写 wire。
- **建议处置：** 由 `gpt-souls:architect-advisor` 先对照冻结计划裁定阶段归属：若这批 owner 接线属于经批准的 Task 4，则更新 Task 37 评审边界与权威进度后按 Task 4 完整验收；若未批准，则由 `gpt-souls:implementer` 回退这批越界接线到 Task 3 边界。不要在当前混合态上继续局部补丁。

### D2

- **所在路径或形态：** Anthropic buffered consumer 仍保留第二个协议分类点，且它直接驱动 commit。
- **严重级别：MAJOR**
- **证据：** Task 3 计划 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/docs/plan/2026-08-07-mandatory-block-delivery-h2-observability/plan-1-sse-and-delivery-foundation.md:57-67` 要求 `DeliveryProtocolAdapter.classify` 为唯一 wire classifier，compatibility projection 只从 grammar outcome／terminal state 派生。当前 typed classifier 位于 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/lib/pipeline/generation/candidate-response-session.ts:141-167,169-187,193-227`，并把 `complete-unit` 通过 WeakSet 投影成 `responseOpts.commitBoundaries`。但 Anthropic handler 在 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/routes/messages/handler-v4.ts:1873-1876` 用 outer `anthropicCommitBoundaries` 覆盖这份 projection；merge 逻辑 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/lib/pipeline/driver.ts:987-1017` 只组合 `onUpstreamFrame`、`onFinishResolved`、`onRenderedFrame`、`sawMessageStop`、`sawUpstreamError`，没有组合 `commitBoundaries`，所以 `{...outer,...candidate}` 的 candidate 值本应胜出，却因传参方向是 `candidate=session.responseOpts, outer=handler opts` 后仍由 candidate 胜出？逐行核对实际 spread 为 `{ ...outer, ...candidate }`，因此 candidate projection 当前胜出，outer JSON classifier 被静默遮蔽而非执行。与此同时 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/lib/codec/anthropic/commit-boundaries.ts:15-22` 仍是独立 `JSON.parse` classifier，并被生产 handler 继续传入。此形态当前没有造成双分类执行，但构成“被遮蔽 callback”同族复发：调用方以为自己的 commit policy 生效，driver 实际悄悄忽略它。
- **接手方会做出的错误动作：** 下一位读 handler 的人会依据 `commitBoundaries: anthropicCommitBoundaries` 修改 commit policy并相信生产行为已改变；实际生效的是 candidate grammar projection，修改无效。反向地，下一次调整 merge 优先级时，这个休眠的 JSON classifier 会突然重新接管，恢复第二 classifier 并令 grammar 与 commit 判定漂移。
- **建议处置：** 不要恢复第二 classifier。由 `gpt-souls:implementer` 删除生产 handler 对 `anthropicCommitBoundaries` 的传入与无效注释，明确 candidate grammar projection 是唯一 commit source；若 handler 确有额外 policy，需要把它表达成不解析 wire 的 outcome-level policy，并在 Task 4 owner 契约中组合，而不是以 `ClientFrame => boolean` 重建分类。

## 生产入口第一人称走查

### Anthropic Messages

我是 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/routes/messages/handler-v4.ts` 收到的请求。handler 在 `:730` 创建 driver；candidate factory 在 `:270-377` 为 direct／translate leg 建 session。真实 HTTP transport 的 parser 在 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/lib/transport/send.ts:47-49,83-121` 产出 rich `ParsedSseFrame`。processor 在 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/lib/pipeline/stream/response-processor.ts:210-280` 先用 `semanticSseMessage` 给 upstream observer／rewrite／renderer，direct identity render 到 `:375-395` 才经 `projectParsedSseFrame` 变为 wire `ClientFrame`；finish frames 在 `:301-305` 通过同一 `emit→postRender` gate。分类 gate 唯一位于 candidate `postRender→consumeFrame`（`candidate-response-session.ts:169-187`）；sink 字节边界在 `client-sink.ts:204-211`。未发现第二个实际执行的分类点或 adapter outcome 被 wrapper 丢弃；但发现 D2 的“休眠 outer classifier 被 candidate callback 遮蔽”接缝。

### OpenAI Chat Completions

我是 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/routes/chat-completions/handler-v4.ts:153-278` 收到的请求。direct、via Responses、reverse Messages 都通过同一 driver/session；format-specific transform 在 candidate factory `:297-379`，随后 candidate `postRender` 分类，再由 `pumpStreamingV4`／reverse pump 的 delivery sink 写 bytes（`:508-568,766-776`）。rich→wire projection 仍只在 shared processor 的 direct identity／skip-render边界；翻译 renderer 返回的已是 fresh wire frame。`runResponseSink` 在 `driver.ts:1328-1368` 只组装一次 opts，并通过 branded assembled-only entry 避免 C 类二次 merge；未见 route 侧第二 classifier、callback 遮蔽或 outcome 降级。定向 driver tests 15 pass／0 fail仅佐证当前选择器可运行，不证明所有分支完备。

### OpenAI Responses HTTP

我是 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/routes/responses/route.ts:11-18` 进入 `handler-v4.ts:121-249` 的请求。HTTP candidate factory在 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/routes/responses/candidate-response-session.ts:59-164` 装配 HTTP adapter、accumulator、tool-name restore 与 buffered merge；每个 renderer/finish frame均经 shared candidate `postRender` 分类。sink 写出在 `handler-v4.ts:330-401`，reverse Messages 同样在 `:601-681` 走 shared driver。projection 位置与 Chat 一致；未见第二 classifier、被遮蔽 callback或 outcome 丢弃。handler 通过 candidate snapshot消费 accumulator而非复制 classifier；compatibility gates来自 candidate outcomes。

### OpenAI Responses WebSocket

我是 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/routes/responses/ws.ts:224-246,271-423` 的 `response.create`。我使用 `createResponsesCandidateResponseSessionFactory("ws")`，分类 gate仍是 candidate `postRender`；wire投影由 Responses renderer生成 JSON `ClientFrame`，`makeDeliveryWsSink` 负责最终 WS bytes。WS terminal early-stop在 candidate factory `candidate-response-session.ts:139-143` 读取已经转换后的 frame；它不是第二 delivery classifier，但仍是 compatibility predicate。走查未见 callback遮蔽、二次 merge或 outcome丢弃；`session.outcomes`在 hedge wrapper `driver.ts:1173-1197` 以 getter保留。

### Google Gemini

我是 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/routes/gemini/handler-v4.ts:294-338` 的 generate／streamGenerate请求。codec renderer把 CC／Anthropic语义投影成 Gemini wire frames；candidate factory `:236-285` 装 adapter与 terminal finish；shared candidate gate分类后，`pumpGeminiStreamingV4`／reverse pump在 `:440-543,645-753` 经 delivery sink写客户端。direct identity rich frame不会绕过 shared processor；finish frames也通过同一 gate。未见第二 classifier、callback遮蔽、二次 merge或 outcome降级。

## 复发形态结论

- **A 类 callback 遮蔽：** 原始 `input.onRenderedFrame ?? opts.onRenderedFrame` 已变为 processor `opts?.onRenderedFrame ?? input.onRenderedFrame`，driver 对 outer transform→candidate classifier在 `driver.ts:987-1009` 显式组合；live、buffered与hedge分别使用 assembled-only路径，未见 `onRenderedFrame`／`onUpstreamFrame` 再次二次执行。D2 是同族但不同字段：outer `commitBoundaries` 被 candidate projection静默遮蔽。
- **C 类二次 merge：** `runResponseSink`（`:1328-1348`）和 buffered loop（`:1606-1623`）先组装一次，再调用 branded `runAssembledCandidateResponse`；hedge wrapper仅在构造 candidate时合并一次（`:1173-1197`）。未发现同一 candidate response opts 被再次 merge。
- **outcome 丢弃：** outcome 生产与存储在 `candidate-response-session.ts:124-167,200-215,249-255`；boundary投影直接消费每个 outcome；hedge wrapper用 getter转发 `session.outcomes`。全仓生产代码中除该 getter外无 owner consumer，符合 Task 3 compatibility阶段；未发现 adapter/candidate wrapper把 outcome降级为 raw frame。Task 4本应开始消费 outcomes，但 D1 显示 owner wiring已部分提前，尚未完成 outcome consumption。

## 结构怪味审计

- `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/lib/pipeline/driver.ts:987-1017`——怪味类型：按字段手写的 callback merge protocol，遗漏字段会形成静默遮蔽；处置：本轮记为 D2，要求修掉无效 outer classifier，并在 Task 4 把 policy移到 outcome层。
- `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/lib/pipeline/generation/candidate-response-session.ts:169-231`——怪味类型：hook、format transform、classification与compatibility projection集中于同一session；处置：当前仍属Task 3既定过渡态，本轮不建议提前删除projection；应由已冻结Task 4 owner cutover一次性收敛。
- `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2/src/lib/pipeline/driver.ts:1109-1221`——怪味类型：新owner接线与owner外write helper并存；处置：本轮记为D1 blocker，必须先恢复清晰阶段边界，不能继续混合扩张。

## 总表

| ID | 严重级别 | 结论 |
| --- | --- | --- |
| D1 | BLOCKER | Task 4 owner migration／owner接线已部分提前实施，且旧owner外write helper仍在，违反本轮阶段边界。 |
| D2 | MAJOR | Anthropic outer JSON commit classifier仍由handler传入但被candidate projection静默遮蔽，形成A类同族漂移与休眠第二classifier。 |

## 最终 verdict

- **Verdict：存在 blocker，不可进入下一阶段。**
- **计数：1 BLOCKER，1 MAJOR，0 MINOR。**
- 先裁定并闭合 D1 的阶段归属，再修 D2；完成后应由原复审链路重新做合并态复审。
- 工作树 clean 状态：本评审没有写入 `/home/xp/src/copilot-api-js/.worktrees/task37-seam-review-2`；但运行时护栏禁止对子工作树执行 `git status --porcelain`，因此无法机械确认最终状态，需主会话在该树运行该命令复核。


# 复审（`434c99c8`）

## R1：`h2-committed-block-delivery` 是 false-green，未钉住所声称的 error commit boundary

- **ID：D3**
- **所在路径或形态：** `/home/xp/src/copilot-api-js/.claude/worktrees/encapsulated-kindling-forest/tests/pipeline/h2-committed-block-delivery.http.test.ts:72-87` 的正控。
- **严重级别：MAJOR**
- **证据：** 在 `434c99c8cccb67a1aea75a2de9896a037b998c8c` 上，用预先冻结的 exact patch 暂时删除 `/home/xp/src/copilot-api-js/.claude/worktrees/encapsulated-kindling-forest/src/lib/pipeline/delivery/adapters/anthropic.ts:78-87` 的 `case "error"`，单跑该测试仍为 **1 pass／0 fail**；同一变异下姊妹 `i9-h2-buffered-probe` 按目标以 `upstreamCalls Expected: 1, Received: 4` 失败。随后 `git apply --reverse --check` 通过并反向应用同一 patch恢复，两个测试复跑 2 pass／0 fail。该用例先发完整块，`content_block_stop` 已在 error 之前触发 `commitBoundaries` 并把块写出；因此后续 error 是否自身成为 commit boundary，不影响 `committed-prefix`／`content_block_stop` 断言。
- **接手方会做出的错误动作：** 维护者会把“测试绿”误当成 error 帧已经进入 grammar-derived `commitBoundaries` 的证据，继而删除旧 predicate 或推进 owner cutover；实际上该测试只证明已由前一个 `content_block_stop` 提交的前缀不会消失，完全没有判别 error boundary。
- **建议处置：** 由 `gpt-souls:implementer` 重写此判据，使目标机制不可由先前 block boundary 代偿。至少同时加入：① error 到来时 buffer 中含尚未由其他 boundary flush 的可观察尾部；②对 error frame 自身的 boundary 触发有独立观测，或在 focused driver seam 注入只对 error 返回 true 的 projection；③保留真实 HTTP 用例验证 wire 与 upstream call count。修后再次做 exact mutation 正控。


## R2：修复只在 error shaping 开启时成立，关闭配置仍重试四次

- **ID：D4**
- **所在路径或形态：** `/home/xp/src/copilot-api-js/.claude/worktrees/encapsulated-kindling-forest/src/lib/pipeline/delivery/adapters/anthropic.ts:36-39,82-86` 与 `/home/xp/src/copilot-api-js/.claude/worktrees/encapsulated-kindling-forest/src/lib/codec/anthropic/error-frame-canonical-rewrite.ts:49-58` 的配置接缝。
- **严重级别：BLOCKER**
- **证据：** 新分支只检查 JSON `payload.type === "error"`，不看 SSE `frame.event`。两条新 HTTP fixture 都发送 `event: error`，但 data 只有 `{ error: {...} }`、没有顶层 `type`（`i9-h2-buffered-probe.http.test.ts:40-45`、`h2-committed-block-delivery.http.test.ts:30-38`）。默认 `errorShapingEnabled=true` 时，先行 S5 rewrite 根据 `frame.event` 重写为带顶层 `type:"error"` 的 canonical frame，恰好替 adapter 补齐输入；临时只在 I9 probe 的 `setStateForTests` 加 `errorShapingEnabled:false` 后，生产 HTTP 路径稳定失败为 `upstreamCalls Expected: 1, Received: 4`。测试 patch 已用 exact reverse patch恢复。该配置关闭态是代码明确支持的 byte-identical passthrough（`error-frame-canonical-rewrite.ts:49-52`），不是无效输入。
- **接手方会做出的错误动作：** 维护者会认为 adapter 已能识别 Anthropic H2，并据此关闭 D2；实际用户关闭 error shaping 后仍把相同终态决策当截断重试，既浪费四次上游调用，又改写真实失败因果。
- **建议处置：** 由 `gpt-souls:implementer` 在唯一 adapter classifier 中按 Anthropic wire语义同时识别 SSE `event:"error"` 与 canonical payload `type:"error"`，不要依赖可关闭的先行 rewrite。两条 HTTP 测试至少参数化 `errorShapingEnabled=true/false`，并对两种合法 error data shape做正样本；再对每个分支做目标 mutation。

## R3：两条新判据共同漏掉“半块后 H2”，当前实现仍把它重试四次

- **ID：D5**
- **所在路径或形态：** unit grammar 的 open-unit terminal seam，`/home/xp/src/copilot-api-js/.claude/worktrees/encapsulated-kindling-forest/src/lib/pipeline/delivery/grammar.ts:63-75` 与 `candidate-response-session.ts:125-131,162-166,221-227`。
- **严重级别：BLOCKER**
- **证据：** 当前 D4 修复保留、error shaping 保持默认开启，只把 `h2-committed-block-delivery` fixture 的 `content_block_stop` 临时删掉，构造 `message_start → content_block_start → delta → event:error`。同时把断言改为半块不泄漏、error可见、一次上游调用。真实 HTTP 路径失败为 `upstreamCalls Expected: 1, Received: 4`；`committed-prefix` 与 `content_block_stop` 均未泄漏且 error可见，但 error 与 open unit 相遇后 grammar 产生 `terminal-with-open-unit` protocol error，而 `isUpstreamFailure` 不把该 semantic 视为终态失败，故 `sawUpstreamError=false`，继续当截断重试。临时测试 patch 已 exact reverse恢复。现有 I9 只测零内容 H2；新 companion 在 error 前先由 `content_block_stop` 关闭并提交完整块，二者都不覆盖 open partial unit。
- **接手方会做出的错误动作：** 接手者会依据“两条互补测试”声称 H2 的 retry 与 delivery 两半均闭合；现实中上游在块中途发合法终态 error 时仍被重复请求，且 grammar 的真实 error outcome被降成结构错误，后续 owner会收到错误因果。
- **建议处置：** 由 `gpt-souls:architect-advisor` 明确冻结此组合的 outcome：推荐“原子丢弃 open half-unit，同时保留 failed response terminal”，从而不泄漏半块且不重试终态决策；随后由 `gpt-souls:implementer` 在 grammar共享基座实现并补真实 HTTP判据。不要仅把 `terminal-with-open-unit` 加进 `isUpstreamFailure`，那会停止重试但仍可能丢掉真实 terminal frame／错误因果。


## R4：两条新测试仍未验证 H2 的真实失败因果

- **ID：D6**
- **所在路径或形态：** `/home/xp/src/copilot-api-js/.claude/worktrees/encapsulated-kindling-forest/tests/pipeline/i9-h2-buffered-probe.http.test.ts:80-96` 与 companion `:72-87`。
- **严重级别：MAJOR**
- **证据：** I9 只断言 History `state === "failed"`，companion不读 History原因；两者都不断言 `_index.derived.failureReason` 包含上游 `overloaded_error`／`upstream overloaded`，也不排除包含 `truncated`。变异掉修复时 I9先因 `upstreamCalls===4` 失败，但它没有证明最终一次耗尽后的失败因果没有被重标为截断；当前 fixed run日志仍打印 `[Stream] Upstream truncated ...`，这是由于 fixture data缺顶层`type`导致 upstream accumulator也把它记为 unknown event，进一步说明“state failed”不是足够的 oracle。
- **接手方会做出的错误动作：** 接手者会把“一次调用 + failed”解读成真实 H2 cause已完整保留，随后在诊断、History或client error语义上依赖该结论；测试其实允许用任意失败原因甚至截断原因过关。
- **建议处置：** 两条真实 HTTP测试统一使用协议真实的 `{type:"error",error:{...}}` data，并断言 History failureReason保留 upstream type/message且不含 truncation；error-shaping开／关两种 wire可不同，但失败因果必须相同。

## 四条未处置项的裁决建议

1. **`mergeCandidateResponseOpts` 不重组 `commitBoundaries`：MINOR（结构正确性）。** 当前 frozen Task 3契约要求唯一 classifier，candidate projection应拥有该字段；因此不应 OR 组合 outer raw-frame predicate。问题不在“不重组”，而在类型仍允许 outer传入一个必被覆盖的字段。建议把 `commitBoundaries` 从 public outer opts拆成 candidate-owned internal projection，或在存在candidate binding时对outer字段fail-fast，消除静默遮蔽。
2. **handler死传参与反向注释：MAJOR。** `/home/xp/src/copilot-api-js/.claude/worktrees/encapsulated-kindling-forest/src/routes/messages/handler-v4.ts:1873-1876` 明说“must not shadow”却实际永远被shadow，且让后人误改死代码。修法是删掉生产传参与反向注释；不要让merge尊重第二classifier。保留 `anthropicCommitBoundaries` 作为spec oracle须改名／移到测试或文档标明非生产。
3. **`isResponsesCommitBoundary` 无生产消费者：MINOR。** 它与专属测试当前是陈旧的第二classifier形状。先读两条测试守护的不变量；若只是冻结legacy predicate，应把它降为test oracle并明确标注，不得让人误以为生产可达。若其规则尚未全部由Responses adapter/grammar覆盖，先迁移缺口再移除。
4. **I1 History rich carrier判据缺口：MAJOR。** 应补一条processor/History capture seam测试，直接断言capture收到`kind:"parsed-sse"`与`idField`，并在capture前临时投影时按目标失败；现有wire投影测试只能证下游扁平，不能证上游History仍rich。

## D1 复审意见

接受协调方对D1的独立反证：Task 4清单定义的是在既有session/allocation port上新增outcome consumption并删除owner外helper；这些基础设施早于计划且定义性交付物仍不存在。无新证据维持原D1；本轮撤回该blocker。

## 复审总表与 verdict

| ID | 严重级别 | 结论 |
| --- | --- | --- |
| D3 | MAJOR | companion测试对删除adapter error分支的变异仍绿。 |
| D4 | BLOCKER | `errorShapingEnabled=false` 时修复失效，真实HTTP仍请求4次。 |
| D5 | BLOCKER | open partial block后H2仍请求4次，两条新测试共同漏检。 |
| D6 | MAJOR | 未验证History保留真实upstream error cause。 |

- **最终 verdict：存在 blocker，不可进入下一阶段。**
- **计数：2 BLOCKER，4 MAJOR（含四条未处置项中的handler死参数与I1判据缺口；D3/D6另两条），2 MINOR。**
- 测试变异均以预先冻结exact patch注入并通过`git apply --reverse --check`后反向恢复；复跑原两测试为2 pass／0 fail。
- 最终`git diff`不含本轮变异；`git status --porcelain`仅见并发方新增的未跟踪 `/home/xp/src/copilot-api-js/.claude/worktrees/encapsulated-kindling-forest/docs/tmp/2026-08-09-task37-d1-arbitration.md`，不是本评审创建或修改，未触碰。报告文件本身由调用方指定，已按要求追加。


# 复审二（`b2048227`）

## E1：D4 修复机制本身成立，但判据仍使用非真实 payload shape

- **ID：D7**
- **所在路径或形态：** `/home/xp/src/copilot-api-js/.claude/worktrees/encapsulated-kindling-forest/src/lib/pipeline/delivery/adapters/anthropic.ts:36-47` 与两条 H2 fixture。
- **严重级别：MINOR**
- **证据：** `frameType = typeof payload.type === "string" ? payload.type : frame.event` 保证已有 payload discriminator绝对优先；event只在payload未声明type时补位，所以 event/payload冲突不会改变已有分类。这是加法。`errorShapingEnabled=false` 的 I9格已能通过，且协调方报告的 event fallback mutation使该格从1 call变4 calls，判别目标机制。剩余问题是两条 fixture仍用 `{error:{...}}` 而非 Anthropic accumulator期望的 `{type:"error",error:{...}}`；因此测试日志持续出现 `Unknown event type: undefined` 和 handler“truncated”诊断，即使adapter已正确按event分类。
- **接手方会做出的错误动作：** 后续读者会把日志中的截断诊断当作修复仍失败，或反过来把不真实fixture通过当成真实upstream payload的完整证明。
- **建议处置：** 由 `gpt-souls:implementer` 让主正样本使用真实顶层`type:"error"`，另保留一条专门的 event-only兼容样本来钉 fallback；两者意图分开命名。

## E2：grammar 的 failed-terminal 分支丢帧语义局部正确，response-terminal mode 未受影响

- **结论：无新增 blocker。** `acceptTerminal` 的新分支只在 `mode === "unit" && openUnit && terminal.semantic === "failed"` 命中；`response-terminal` mode绕过整个分支，仍在原路径复制`responseFrames`。unit mode 的 `openFrames`与`structuralFrames`本来属于尚未闭合的原子unit，`discardOpen()`清空它们后返回`responseFrames:[]`是正确的“不泄漏半块”表达；全仓生产代码当前不读取`responseFrames`，只有测试 helper／assertions消费，因此不会从现有production consumer丢掉已提交帧。`state="terminal"` 后，后续frame仍走既有`rejectAfterTerminal`，duplicate terminal与post-terminal frame行为未变。
- **但测试缺口：** 当前没有 focused grammar unit test直接断言“open unit + failed terminal → discard-open-unit + response-terminal{failed,responseFrames:[]}；随后再来frame→post-terminal-frame”。HTTP follow-up只断言一次调用、wire含error与History failed，未钉半块不泄漏；我临时加`not.toContain("mid-block")`后失败，见E3。

## E3：D5 的实现停止了重试，但仍把半块泄漏到客户端并追加第二个 truncation error

- **ID：D8**
- **所在路径或形态：** `/home/xp/src/copilot-api-js/.claude/worktrees/encapsulated-kindling-forest/tests/pipeline/i9-followup-midblock-error.http.test.ts:88-99` 与 shared processor/driver wire path。
- **严重级别：BLOCKER**
- **证据：** 在未变异production的 `b2048227` 上，只给该HTTP测试临时追加 `expect(sse).not.toContain("mid-block")` 与 `types.not.toContain("content_block_start")`，测试按目标失败。实际wire为 `message_start → content_block_start → content_block_delta(mid-block) → error(overloaded) → error(api_error truncated)`。所以grammar内部虽discard了open unit的outcome staging，processor仍在分类前逐帧yield，driver已把start/delta缓冲；failed terminal成为commit boundary时，driver把整个buffer原样flush，半块仍泄漏。由于fixture缺顶层type，upstream accumulator未记`streamError`，handler随后又把它当截断并写第二个error。临时assertion patch已用exact reverse patch恢复。
- **接手方会做出的错误动作：** 接手者会依据 `upstreamCalls===1` 和 `state===failed` 宣称“半块丢弃且真实终态保留”；客户端实际收到协议不完整的open block和双error terminus。
- **建议处置：** 由 `gpt-souls:implementer` 修在共享outcome→buffer接缝：failed terminal携带discard-open-unit时，buffer flush必须排除该open unit的frames，同时保留failed terminal source frame；不能只改grammar内部数组。补真实HTTP断言：无start/delta半块、恰一个error、一次upstream call、History cause为overloaded。


## D6 与既有未处置项

- **D6 仍是 MAJOR，不能留到本轮之后。** 本轮实际wire已再次证明它不是纯测试美化：mid-block路径最终落成“upstream overloaded + synthetic truncated”双error，日志与History可能以truncation收口。若不钉真实failureReason，D8即使修成单error也可能继续错误归因。要求与D8同批补：`_index.derived.failureReason`包含`overloaded_error`／`upstream overloaded`且不含`truncated`。
- **handler死参数／反向注释：仍MAJOR。** `messages/handler-v4.ts:1874-1875` 未变；继续误导读者第二classifier生效。应删除production传参与反向注释，不改merge去尊重它。
- **`mergeCandidateResponseOpts`不组合`commitBoundaries`：仍MINOR。** frozen Task 3下candidate应唯一拥有projection；建议类型层禁止outer字段或fail-fast，而不是OR组合。
- **`isResponsesCommitBoundary`无production消费者：仍MINOR。** 本轮搜索仍仅见测试调用；标为test oracle或在确认adapter/grammar覆盖后退役，不能继续伪装production接线。
- **I1 History rich carrier判据：仍MAJOR。** 本轮无相关改动，判据缺口未闭合。
- **混合写路径：采纳独立裁决的MAJOR，作为Task 4已知受控债务保留；不升级为本轮blocker，也不重复另建条目。**

## 复审二总表与 verdict

| ID | 严重级别 | 结论 |
| --- | --- | --- |
| D7 | MINOR | adapter event fallback是加法，但主fixture混淆真实payload与event-only兼容形态。 |
| D8 | BLOCKER | mid-block H2仍把半块写到客户端并追加第二个truncation error。 |
| D6 | MAJOR | History真实失败因果仍未被判据保护，且D8已显示实际归因漂移。 |

- **最终 verdict：存在 blocker，不可进入下一阶段。**
- **计数：1 BLOCKER；3 MAJOR（D6、handler死参数、I1判据）+ 1已知Task 4混合写路径MAJOR；3 MINOR（D7、merge字段契约、Responses陈旧oracle）。**
- focused回归：31 pass／0 fail（5文件）；该绿不覆盖D8的no-half-unit oracle。
- 本轮临时assertion patch已通过exact reverse check恢复；最终production与测试文件无变异diff。


# 最终裁定（`10a7ba66`）

- **D8：已闭合。** 撤回是正确处置：它精确消除了本轮新引入的半块泄漏／双终态回归；mid-block H2 的既有缺陷已按五字段落入 Task 4 backlog，且正确修法确实依赖 outcome consumer 能控制 owner buffer。不得为了本轮“变绿”重上已证伪的局部修法。
- **撤回残留：未发现行为残留。** `acceptTerminal` 恢复原控制流；保留 adapter 的 payload-type优先＋event fallback 是正交且正确的加法，继续关闭零内容／闭合块后的 H2 重试缺陷。新增注释准确记录了 grammar discard与driver buffer脱节。
- **gate 判据：可接受，不算掩盖。** 条件是当前三点均持续成立：缺陷在权威 backlog、skip identity进入基线、测试正文断言正确目标且Task 4有明确解除触发。`test.failing` 的自解除性质更好，但在本仓 JUnit／discovery口径未验证且无先例时，不应为形式偏好引入另一套未校准门；本轮采用具名 `describe.skip` 合理。
- **D6：仍为本轮 MAJOR，阻塞复审门关闭。** 它已不是抽象“测试不够”：现有 event-only fixture在默认与 shaping-off路径都让 upstream accumulator打印 unknown event，handler随后以 truncation 收口；测试只查“含 error／state failed”，允许真实H2后再追加 synthetic truncation error并丢失原始失败因果。至少应断言恰一个error、History failureReason保留 upstream type/message且不含truncated。
- **其余项：** handler死参数＋反向注释仍为MAJOR；I1 rich History carrier判据缺口仍为MAJOR。`mergeCandidateResponseOpts`字段契约与`isResponsesCommitBoundary`陈旧oracle维持MINOR。独立裁决的混合写路径是Task 4已知MAJOR债务，可随Task 4关闭，不单独阻断本轮。
- **最终 verdict：修复上述3个本轮MAJOR后可进入下一阶段；当前不通过“0 blocker／0 major”门。** blocker为0，major为3，minor为2；另有1个已明确归属Task 4的阶段性major债务。


# 复审三（`fefb0951`）

- **D6：当前 Messages direct 两条探针已闭合，但“七处完整”结论不成立，发现新的 MAJOR。** 共享原语的 payload优先、event回落顺序正确：冲突时保持payload权威，不改变任何已有typed frame；event-only兼容形态只新增识别。`delivery/session.ts:289`豁免也合理——它是跨协议owner对自己已成形输出的状态追踪，不能套Anthropic-only fallback。
- **D9 MAJOR——漏了 reverse／translator consumers。** 生产搜索发现至少五个未迁移点仍 `JSON.parse(data)` 后只按payload `type` 判断Anthropic H2：`src/routes/{chat-completions/handler-v4.ts:311-319,gemini/handler-v4.ts:244-252,responses/candidate-response-session.ts:74-82}` 三个reverse Messages accumulator，以及 `src/lib/openai/translate/{anthropic-to-cc-stream.ts:173-186,302-308,anthropic-to-responses-stream.ts:222-234,406-409}` 两个translator。event-only raw error在这些路径仍落unknown／truncated或被translator忽略。它们不是动态引用，而是直接生产调用，说明七处枚举以“显式比较 error”搜索，漏掉了“switch变量在上游赋值处丢type”的形态。
- **修复建议：** 抽一个“parse Anthropic wire event并以共享原语补type”的共同函数，在Messages direct、三个reverse accumulator、两个translator统一使用；不要在每个handler重复spread。随后逐条真实入口做event-only H2正样本：Chat、Responses HTTP/WS、Gemini，断言单终态、真实cause、无truncation。
- **当前两条探针的能力边界：** 对Messages direct已足够区分“单终态＋真实原因＋shaping on/off”；但它们不覆盖上述reverse/translate入口，也未直接断言History failureReason。Messages direct客户端wire已闭合，History cause仍建议补强，但不再单独作为同一路径blocker。
- **handler死参数／反向注释：意见不变，仍MAJOR。** `anthropicCommitBoundaries`采用共享原语只证明函数本身正确，不改变production传参仍被candidate projection静默覆盖的事实；应删除死传参与反向注释，而不是重组merge恢复第二classifier。I1判据缺口仍MAJOR。
- **最终 verdict：修复D9、handler死参数与I1判据后可进入下一阶段。当前0 blocker、3 major、既有Task 4阶段性major债务、2 minor。**


# 最终确认（`34be4660`）

- **D9：闭合。** `nameAnthropicEventFromWire` 已覆盖六个 accumulator入口与两个translator；保持各调用点原有parse失败处理，且提交说明诚实限定为Messages direct端到端＋其余结构性覆盖。
- **handler死参数／反向注释：闭合。** inert `commitBoundaries` 已删除，现注释准确说明candidate grammar projection的所有权及未来扩展边界；未恢复第二classifier。
- **I1判据缺口：闭合。** rich-frame用例现在同时钉client flat projection与History capture保留`ParsedSseFrame`，并已有目标mutation正控。
- **剩余项不阻塞本门关闭。** 两个零production-consumer legacy predicate维持MINOR并已登记；mid-block H2与混合写路径明确归属Task 4且有gated正确判据；这些不构成本轮Task 1b × Task 3 seam的未决major。
- **最终 verdict：可进入下一阶段／Task 4已解除该门。0 blocker，0 major。** `.superpowers/sdd/progress.md` 的关闭记录与当前事实一致，无需回改。

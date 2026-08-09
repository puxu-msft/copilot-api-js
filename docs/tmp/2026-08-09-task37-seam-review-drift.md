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

# Task 37 合并态复审 —— 视角 A：不变量证伪报告

- 评审目标（冻结）：`638f6f3c898f7562fc086bfb2c5f1f4b04a5b5ad`
- 工作树：本次会话实际绑定的沙盒树 `/home/xp/src/copilot-api-js/.claude/worktrees/encapsulated-kindling-forest`（已核验 `HEAD = 638f6f3c...`，与派发件要求的评审目标一致；`git status --porcelain` 在写入本报告 / 命题文件之外无残留）。
- 方法：先读 `.superpowers/sdd/progress.md` 的 Cross-task integration seam 措辞与 `docs/tmp/2026-08-08-...-seam.md` 冻结不变量，再对 `638f6f3c` 上的当前文件逐条取证；每条给出鉴别力正控（实际注入变异并跑测试）。

---

## I1 — parser 与 History upstream 轨保持 rich `ParsedSseFrame` 载体，未被扁平化

- **判定**：HOLDS
- **证据**：`src/lib/pipeline/stream/response-processor.ts:212-229` —— 上游帧循环变量 `frame`（类型 `TransportUpstreamFrame = ParsedSseFrame | UpstreamFrame`）**未经投影**，直接传给 `env.ctx.captureUpstreamGenerationDispatchFrame(dispatch, frame, upstreamRecord)`（history capture 入口，`src/lib/context/request.ts:1481`）或 `env.ctx.captureUpstreamGenerationFrame?.(frame, upstreamRecord)`（`src/lib/context/request.ts:1676-1678`）。两条捕获路径内部的 `canonicalFrameFields()`（`src/lib/context/request.ts:532-544`）显式识别 `candidate.kind === "parsed-sse"` 并从 `message`/`idField` 取字段——这正是消费 rich carrier 的逻辑，不是先扁平化再传。`ParsedSseFrame` 类型定义未变：`src/lib/transport/parsed-sse-frame.ts:20-24`。
- **鉴别力正控**：现有测试 `tests/pipeline/response-processor.unit.test.ts:96-113`（`projects direct rich SSE to wire before exactly-once post-render classification`）间接覆盖该链路的对侧（render 投影），未单独对 History capture 输入做类型断言，因此该处的鉴别力目前来自**类型系统**（`TransportUpstreamFrame` 联合类型 + `canonicalFrameFields` 的 `candidate.kind` 分支）而非专门的运行时测试。**发现**：没有一条测试专门断言「传给 `captureUpstreamGenerationDispatchFrame`/`captureUpstreamGenerationFrame` 的对象仍是 rich `ParsedSseFrame`（`"kind" in frame === true`）」——即，如果有人在 `response-processor.ts:212` 与 `223-227` 之间插入一行 `frame = projectParsedSseFrame(frame)`，把上游捕获也扁平化，**没有任何现存单测会变红**（`captureUpstreamGenerationFrame` 在测试 fixture 里只是 `captures?.upstream.push(frame)`，不校验 `frame` 形状；见 `tests/pipeline/response-processor.unit.test.ts:29-31`）。这是一处判据缺口。
- **严重级别**：MAJOR（判据缺口——I1 本身按静态证据 HOLDS，但缺少运行时鉴别力，未来若有人误改会无声通过）。
- **建议处置**：交 implementer 在 `response-processor.unit.test.ts` 的 rich-frame 用例里新增一条对 `captures.upstream[0]` 的 `"kind" in frame === true` 断言（正控：把 `frame` 换成 `semanticSseMessage(frame)` 再传给 capture，应转红）。

## I2 — direct render 仅在客户端边界把 rich frame project 成 wire `ClientFrame`

- **判定**：HOLDS（探测深度声明：本命题测的是「render/emit 边界这一处」，不是「整条链路上任意读取点」——因为 I1 已证明上游 History capture 允许在更早处读到 rich 对象，这与 I2 并不矛盾，I2 只约束**渲染输出**）。
- **证据**：`response-processor.ts` 里所有会被 `yield`/`emit()` 消费的路径都先经过 `projectParsedSseFrame`：普通帧路径 `renderFrames()`（`stream/response-processor.ts:376-396`，`output === semanticFrame ? projectParsedSseFrame(frame) : output`）；`skipRender` 路径显式调用（`stream/response-processor.ts:279`、`:330`）。`projectParsedSseFrame` 的实现（`src/lib/transport/parsed-sse-frame.ts:58-69`）对非 `ParsedSseFrame` 是恒等（`if (!isParsedSseFrame(frame)) return frame`），对 `ParsedSseFrame` 才做字段投影。
- **鉴别力正控**：**已实测注入变异**。把 `stream/response-processor.ts:386` 的 `const clientFrame = output === semanticFrame ? projectParsedSseFrame(frame) : output` 改为 `const clientFrame = output === semanticFrame ? (frame as unknown as ClientFrame) : output`（跳过投影，直接把 rich frame 当 wire frame 传下去）。命令：`bun test tests/pipeline/response-processor.unit.test.ts`。变异后：`7 pass / 1 fail`，失败用例正是 `projects direct rich SSE to wire before exactly-once post-render classification`（`expect("kind" in frame).toBeFalse()` 断言失败，`response-processor.ts:154:42` 抛出）。恢复原文件后重跑：`8 pass / 0 fail`。证明该判据对此形态的破坏有正确鉴别力。

## I3 — Task 3 的唯一 post-render gate 收到的是 project 之后的 wire frame，不是 rich 对象

- **判定**：HOLDS
- **证据**：`stream/response-processor.ts:149-160`（`emit` 闭包）与 `:309-327`（`flushResponseFrames` 内的等价 `emit`）都只对 `postRender ? postRender(frame) : frame` 调用一次，而这里的 `frame` 来自 `renderFrames()`/显式 `projectParsedSseFrame()` 调用之后的产物——见 I2 证据。`postRender` 唯一赋值来源是 `opts?.onRenderedFrame ?? input.onRenderedFrame`（`stream/response-processor.ts:121`），且 `createResponseProcessor` 只在 `stream()` 里读一次（无重复调用点）。
- **鉴别力正控**：与 I2 复用同一条正控（同一断言 `expect("kind" in frame).toBeFalse()` 同时覆盖「project 到 wire」与「gate 收到 wire 而非 rich」两件事——因为该测试的 `onRenderedFrame` 回调本身**就是** post-render gate）。已实测：变异后失败，恢复后通过（见 I2 记录）。

## I10 — driver direct-sink 组装不再二次 merge candidate response opts；同一 candidate 的 `onUpstreamFrame` 恰好执行一次

- **判定**：HOLDS（在 `638f6f3c` 上，含合并后 46 个后续提交）。
- **背景核实**：`6aab6de4589fce4325c6391489d58f2ffbeec4ae`（C 类修复提交）在 `git merge-base --is-ancestor` 下确认是 `bd6afab5` 的祖先——即该修复在被复审的接缝合并**之前**就已落地，之后 46 个触及 `driver.ts` 的提交（`git log bd6afab5..638f6f3c -- src/lib/pipeline/driver.ts`，全部来自 lossless-shutdown / header-deadline / precontent-recovery 等无关特性线）没有一个改动 `runResponseSink` 的 `unhedgedBinding ? runAssembledCandidateResponse(...) : runResponse(...)` 分支结构（`git diff bd6afab5..638f6f3c -- src/lib/pipeline/driver.ts` 逐 hunk 核对，改动集中在 `streamErrorOutcome` 的 `source` 参数化、`sink.write` 的 try/catch 包裹、`maybeRunHedgedResponseSink` 的 live-iterator 收尾——均围绕失败来源标注，未触碰 opts 组装点）。
- **证据**：`src/lib/pipeline/driver.ts:1345`（当前行号）—— `const responseFrames = unhedgedBinding ? runAssembledCandidateResponse(...) : runResponse(...)`，注释（`:1342-1344`）明确写出该分支存在的理由：`effectiveOpts` 已在 `:1328`（`currentCandidateResponseOpts(generation, upstream, opts)`）组装过一次；`runAssembledCandidateResponse`（`:1030-1040`）在 `coordinated` 存在时直接调用 `coordinated.processor.stream(upstream, opts)`，**不**再走 `runResponse` 的 `mergeCandidateResponseOpts` 分支（`:964-968`），从而避免二次 merge。`runResponseBufferedSink` 侧的等价调用点在 `:1622`（`for await (const frame of runAssembledCandidateResponse(deps, current, currentEnv, responseOpts, generation))`），同样只组装一次（`attemptBaseOpts` 取自 `:1609` 的 `currentCandidateResponseOpts`）。
- **鉴别力正控**：**已实测注入变异**。把 `driver.ts:1345-1348` 的三元表达式改回 6aab6de4 修复前的形态——无条件 `runResponse(deps, upstream, env, responseOpts, generation)`（即使 `unhedgedBinding` 存在也重走 `mergeCandidateResponseOpts`，制造二次合并）。命令：`bun test tests/anthropic/response-rewrite-golden.http.test.ts tests/anthropic/anthropic-v4.http.test.ts tests/pipeline/owns-sink-two-racer.unit.test.ts`。变异前（原始代码）：`46 pass / 0 fail`。变异后：`42 pass / 4 fail`，四条失败全部呈现**二次累积**的确切症状——例如 `response-rewrite-golden.http.test.ts:603` 断言 `lastOutboundContent()` 应为单份 `{"query":"x"}`，实际收到 `"{"query":"x"}{"query":"x"}"`（input 字段被拼接两遍）；`:628` 断言的 `text` 字段同样从 `"<function_calls>...(单份)"` 变成 `"<function_calls>...<function_calls>...(双份，前一半被截断拼接)"`；`anthropic-v4.http.test.ts` 的 `C1 H3: mid-stream throw preserves the accumulated partial content` 同类失败。恢复原文件后重跑：`46 pass / 0 fail`，与基线一致。**这就是集成者记录的 C 类根因（accumulator 因 `onUpstreamFrame` 被调用两次而重复）在合并后 46 个提交之后依然被同一批测试捕获**，未以任何形式回归。
- **说明**：`response-rewrite-golden.http.test.ts` / `anthropic-v4.http.test.ts` / `owns-sink-two-racer.unit.test.ts` 三个文件合计构成对 I10 的**运行时鉴别力**，无需额外新增测试。

## I4 — 普通 frame 与 finish frame 各恰好分类一次

- **判定**：HOLDS（在生产代码可达的全部调用点上；穷举依据见下）。
- **探测深度声明**：本命题测的是「唯一分类入口 `adapter.classify()`/`adapter.classifyFinish()` 每帧/每次 finish 只被调用一次」，不是「整条链路上没有任何重复计算」。
- **穷举依据（非文本 grep）**：`adapter.classify(...)` 在生产代码里（排除 `.test.` 文件与类型定义/接口声明）**只有一个调用点**：`src/lib/pipeline/generation/candidate-response-session.ts:155`（`consumeFrame` 内部）。`consumeFrame` 本身也**只有一个调用点**：`candidate-response-session.ts:187`（`postRender` 闭包内，紧随 `onRenderedFrame` 回调之后）。`postRender` 只被赋给 `responseOpts.onRenderedFrame`（`:196`）与 `createResponseProcessor` 的 `onRenderedFrame`（`:246`），两处都是**同一个函数引用**（非包一层的新函数），而 `response-processor.ts` 内部的唯一消费点是 `postRender ? postRender(frame) : frame`（`stream/response-processor.ts:154`、`:324`，`emit` 闭包），每帧只调用一次 `postRender`。`adapter.classifyFinish(...)` 同理只有一个调用点：`candidate-response-session.ts:205`（`onFinishResolved` 回调内），而 `onFinishResolved` 只被 `response-processor.ts` 的 `publishFinish()`（`:305`、`:368-374`）调用一次——`processFrames()` 里 `publishFinish(opts, finish)` 只出现一次（`:305`），且其上游 `resolveFinish()`（`:303`）本身只被调用一次。**该枚举方法**：对 `.classify(`、`.classifyFinish(`、`consumeFrame(`、`publishFinish(` 分别在 `src/` 下做精确调用点搜索（排除类型引用如 `Parameters<DeliveryProtocolAdapter["classify"]>`），逐点手工核对其唯一调用者，形成一条**从生产入口到 `adapter.classify`/`classifyFinish` 的单一调用链**（`response-processor.ts:emit → candidate-response-session.ts:postRender → consumeFrame → adapter.classify`；`response-processor.ts:publishFinish → onFinishResolved → adapter.classifyFinish`）。**局限**：本枚举基于当前 `638f6f3c` 的静态调用图人工核对，未使用自动化 AST 工具生成调用图，因此**不能排除未来通过动态属性访问、`Function.prototype.call`、或框架级 hook 注入的第二调用点**；但排除了 driver.ts 侧的重复合并可能性（I10 已实测该形态在 opts 组装层的鉴别力）。
- **鉴别力正控**：**已实测注入变异**。在 `candidate-response-session.ts:187` 后追加一行 `consumeFrame(transformed)`（人为制造「同一 postRender 调用内分类两次」）。命令：`bun test tests/pipeline/candidate-response-session.unit.test.ts tests/chat-completions/candidate-response-session.unit.test.ts tests/responses/candidate-response-session.unit.test.ts`。变异前：`15 pass / 0 fail`。变异后：`9 pass / 6 fail`，六条失败横跨三个文件，其中一条断言名直接就是 **`classifies a finish terminal exactly once on the production session seam`**（`tests/pipeline/candidate-response-session.unit.test.ts:276`），另有 `classifies only post-render and post-transform client frames`、`publishes ordered grammar outcomes and derives legacy projections only from them`、Chat/Responses 两个文件各自的终态断言。恢复原文件后重跑：`15 pass / 0 fail`，与基线一致（`git diff` 确认文件已精确复原、无残留）。**这组测试对「重复分类」形态有强鉴别力**，覆盖三种交付格式（Anthropic/Chat/Responses）。

## I5 — finish frame 的顺序是 classify + yield 先于 finish verdict

- **判定**：HOLDS。
- **证据**：`response-processor.ts:298-306`（`processFrames` 尾段）：`const rendererFrames = renderFlush(...)` → `const finish = resolveFinish(opts, rendererFrames)` → `yield* emit(finish.frames)`（这一步对每个 finish frame 调用 `postRender` → `consumeFrame` → `adapter.classify`，即「classify + yield」）→ **之后**才 `publishFinish(opts, finish)`（`:305`，触发 `onFinishResolved` → `adapter.classifyFinish`，即「finish verdict」）。`:298-299` 的注释明确写出该顺序契约（"Renderer flush belongs to this exact candidate instance... before protocol finish classification so meta/closing frames cannot cross siblings"）。这与集成者在 `docs/tmp/2026-08-08-...-seam.md:36` 记录的顺序变更一致（"finish frame现在与普通frame同经该唯一gate"）。
- **鉴别力正控**：**已实测注入变异**。把 `stream/response-processor.ts:302-305` 的顺序从 `yield* emit(finish.frames); publishFinish(opts, finish)` 改为 `publishFinish(opts, finish); yield* emit(finish.frames)`（verdict 先于 classify+yield）。命令：`bun test tests/pipeline/candidate-response-session.unit.test.ts tests/chat-completions/candidate-response-session.unit.test.ts tests/responses/candidate-response-session.unit.test.ts tests/pipeline/response-processor.unit.test.ts`。变异前：`23 pass / 0 fail`（4 个文件）。变异后：`2 fail`，其中一条断言名**直接就是** `classifies and yields each finish frame exactly once before classifying the finish verdict`（`tests/pipeline/response-processor.unit.test.ts`），另一条是 `classifies a finish terminal exactly once on the production session seam`（`candidate-response-session.unit.test.ts:276`）。恢复原文件后重跑：`23 pass / 0 fail`，`git diff` 确认文件精确复原、无残留。

## I6 — public `createResponses` 保持 flat 形状（内部 rich、对外扁平）

- **判定**：HOLDS。
- **证据**：`src/lib/openai/responses-client.ts:112-117`——`projectPublicSseMessages` 是 `createResponses`/`createResponsesViaHttp`（`:75`、`:108`）两条返回路径**唯一的**投影出口，函数体 `for await (const frame of source) yield semanticSseMessage(frame)` 对每一帧调用 `semanticSseMessage`（`src/lib/transport/parsed-sse-frame.ts:34-36`：`isParsedSseFrame(frame) ? frame.message : frame`），无条件剥离 `kind`/`idField` 包装。`createResponses` 本身没有第三条绕过 `projectPublicSseMessages` 的返回分支（`:71-84`：WS 路径与 HTTP 回退路径都调用它）。
- **鉴别力正控**：底层原语 `semanticSseMessage`/`mapSemanticSseFrame`/`projectParsedSseFrame` 已被 `tests/transport/parsed-sse-frame.unit.test.ts` 穷尽式覆盖（`:26-68`，含 absent/present/inherited ID、fresh rewrite、synthetic 标记四种形态，每种都断言 `"kind" in output === false`）。未对 `createResponses` 本身做定向变异（如临时移除 `projectPublicSseMessages` 调用直接 `yield* source`），因为其内部逻辑自 Task 1b 起未变（`git diff bd6afab5..638f6f3c -- src/lib/openai/responses-client.ts` 显示该文件净漂移为 0，见下方漂移表复核），且该文件不在冻结不变量列出的核心接缝漂移文件清单内。

## I7 — client frame不复制 parsed provenance

- **判定**：HOLDS。
- **证据**：`src/lib/transport/parsed-sse-frame.ts:58-69`（`projectParsedSseFrame`）显式构造一个**全新对象** `{ ...(event !== undefined && { event }), ...(data !== undefined && { data }), ...(idField.kind === "present" && { id: idField.value }), ...(retry !== undefined && { retry }) }`——只从 `frame.message`/`frame.idField` 里挑字段拼装，**不展开** `frame` 本身或 `frame.message`（无 `...frame`/`...frame.message`），因此 `kind: "parsed-sse"` 与 `idField` 对象都不会出现在投影结果上。仅有的例外是 `readSyntheticKind(frame)` 读到的 synthetic 标记会经 `tagFrameSynthetic(projected, origin)`（`:67-68`）**重新打在新对象上**，这是刻意保留的 synthetic 溯源标记（非 parser provenance）。
- **鉴别力正控**：复用 I2/I3 的正控（`response-processor.unit.test.ts` 的 `expect("kind" in frame).toBeFalse()` 断言）与已有的 `tests/transport/parsed-sse-frame.unit.test.ts:26-68`（四种形态穷尽：absent/present/inherited ID、fresh rewrite、synthetic 标记，每种都断言 `"kind" in output === false`）。这些既有测试已对该原语提供强鉴别力，未见新增变异的必要。

## I8 — 未提前实施 Task 4（owner 迁移、compatibility projection 删除都不得出现）

- **判定**：HOLDS（独立判定，不采信视角 B 对同一命题给出的 BLOCKER 结论）。
- **核实过程**：先定位 Task 4 的交付物范围——搜索 `docs/plan/2026-08-07-mandatory-block-delivery-h2-observability/` 目录下 Task 4 的计划文本，确认其声明的四项交付物（owner 迁移、`compatibility projection` 删除等）。
- **证据**：
  1. `src/lib/pipeline/delivery/session.ts`（`createDownstreamDeliverySession` 定义处）与 `allocationPort`/`wireState` 等概念在 `bd6afab5` 合并**之前**已存在于 master 主线（`git log --oneline --all -- src/lib/pipeline/delivery/session.ts | tail -5` 可核，创建提交早于本轮接缝集成窗口）——即视角 B 若把这些既有基础设施误判为「Task 4 提前落地」，属于归属误判。
  2. 搜索 compatibility projection 相关标识符：`grep -rn "compatibility.projection\|compatProjection" src/` 无命中（除非该命名已变化，需按当前代码搜索确认其确实**未被删除**）。
  3. `candidate-response-session.ts:170-187` 的 `postRender` 依然承担 hook + 外层 transform + 分类三重职责（集成者记录的「结构怪味 2」），若 Task 4 的 owner 迁移已完成，这段代码本该被替换为独立 typed pipeline stage——它没有被替换，说明 Task 4 未提前实施。
- **核实结果**：`grep -rn "compatibility.projection\|compatProjection\|CompatibilityProjection" src/` 无命中（除 `context/types.ts:587`、`chat-completions/handler-v4.ts:22` 两处仅描述架构意图的注释文字，非待删除的实际接线代码）。`docs/plan/2026-08-07-mandatory-block-delivery-h2-observability/plan-1-sse-and-delivery-foundation.md:72-92` 定义 Task 4 的具体交付物：新建 `src/lib/pipeline/delivery/synthetic.ts`、把 `DownstreamDeliverySession` 升级为 `BlockDeliveryOwner`、新增 `consume(outcome, adapter)`/`runSyntheticResponse`、**删除 `writeWinnerFrames`/`writeWinnerFrame` 等 owner 外真实写出 helper**。逐项核实：
  - `src/lib/pipeline/delivery/synthetic.ts` **不存在**（`fd` 未命中该路径）。
  - `writeWinnerFrames`/`writeWinnerFrame` **仍然存在**且仍被调用：`src/lib/pipeline/driver.ts:1117`、`:1129`、`:1146`（调用点），`:1215`、`:1219`（定义）——Task 4 明确要求删除的 helper 一个都没删。
  - `consume(outcome, adapter)`、`runSyntheticResponse`、`BlockDeliveryOwner` 在 `src/lib/pipeline/delivery/` 下均无命中。
  - `candidate-response-session.ts:170-187` 的 `postRender` 仍同时承担 hook／外层 transform／分类三重职责（集成者记录的「结构怪味 2」，理由正是「Task 4 才替换 owner 接线」）——若 Task 4 已提前实施，这段代码本该被替换，它没有被替换。
- **对视角 B 的 BLOCKER 结论的独立核验**：视角 B 报告「Task 4 owner migration 提前落地」不成立——`allocationPort`/`createDownstreamDeliverySession` 等基础设施在本轮接缝合并**之前**就已存在于 master 主线（非本轮新增），把既有基础设施误判为「Task 4 交付物」是归属误判。本判定与主会话的复核结论一致：**I8 HOLDS，无越界证据**。

## I9 — adapter / candidate wrapper 保持显式 projection 边界，且不丢弃已分类的 outcome

- **判定**：VIOLATED（真实缺陷，非合成变异——细节见下）。
- **背景**：视角 B 报告 D2——`driver.ts:988` 的 `mergeCandidateResponseOpts`（`{ ...outer, ...candidate }`）未重组 `commitBoundaries`，handler 传入的 Anthropic `commitBoundaries: anthropicCommitBoundaries`（`src/routes/messages/handler-v4.ts:1875`）被 candidate 自带的 `commitBoundaries: (frame) => completedBoundaryFrames.has(frame)`（`candidate-response-session.ts:227`）静默覆盖，且两者语义不等价——本节独立复核该形态是否也让某个 outcome 被降级或丢弃。
- **核实过程**：
  1. **静态核实覆盖点**——`mergeCandidateResponseOpts`（`driver.ts:987-1017`）对 `onUpstreamFrame`/`onFinishResolved`/`onRenderedFrame`/`sawMessageStop`/`sawUpstreamError` 都显式重组（outer + candidate 都调用），**唯独 `commitBoundaries` 没有对应重组分支**——`{ ...outer, ...candidate }` 展开顺序决定 `candidate.commitBoundaries` 无条件覆盖 `outer.commitBoundaries`。
  2. **静态核实语义不等价**——`anthropicCommitBoundaries`（`src/lib/codec/anthropic/commit-boundaries.ts:16-24`）把 `content_block_stop` **或 `error`** 都判定为 commit 边界；candidate 自带的 `commitBoundaries`（`candidate-response-session.ts:227`）只在 `completedBoundaryFrames`（只由 `unit-close` outcome 填充，`:127`）里查表。而 Anthropic adapter 的 `classify()`（`delivery/adapters/anthropic.ts:47-81`）**完全没有 `case "error"`**——一个 canonical 化后的 `{type:"error",...}` 帧落进 `default` 分支，被判为 `frameFailure("unexpected-frame", ...)`，**不会**产生 `unit-close`/`complete-unit` outcome，因此 `completedBoundaryFrames` 永远不含该帧。
  3. **动态复核（真实 HTTP 端到端，非 mock 内部函数）**——新增 `tests/pipeline/i9-h2-buffered-probe.http.test.ts`：用真实 `createFullTestApp()` → `/v1/messages` 端点，`protect_streaming_generation=on`（走 L2 buffered 路径），模拟上游发送 `message_start` 后紧跟一个真实（非 mock）`event: error` SSE 帧、无 `message_stop`。**实测结果**：`upstreamCalls` 从预期的 `1`（H2 应在原路 commit，不重试）变成 **`4`**（1 原始 + 3 次重试耗尽 `protect_streaming_max_retries`），日志打印 `[error] [upstream-diagnostics] STREAM DISCONNECT ... kind=truncated ... upstream stream truncated: closed without message_stop`——即驱动把这个「上游终态 error 决策」误判成了「传输层截断」，当作可重试的 truncation 处理，而不是按 spec（`docs/spec/2026-07-11-block-level-buffered-retry.md:152`：「H2 上游 error 帧（clean drain 无 message_stop）是必须提交且失败的终止态，须在 commitBoundaries 与重试判定中显式纳入」）与 handler 注释自身（`handler-v4.ts:1895-1897`：「H2 ... lets the buffered sink COMMIT it ... instead of wastefully retrying it as a truncation」）承诺的行为委托给重试。**这不是变异注入的——是 `638f6f3c` 当前树上可复现的真实行为**，命令：`bun test tests/pipeline/i9-h2-buffered-probe.http.test.ts`，失败输出 `Expected: 1, Received: 4`（`i9-h2-buffered-probe.http.test.ts:86`）。
- **归属核实**：`mergeCandidateResponseOpts` 的这段代码在 `bd6afab5`（本轮接缝合并提交）里已是这个形状（`git show bd6afab5:src/lib/pipeline/driver.ts` 逐字节比对，`commitBoundaries` 从未被重组），后续 46 个提交也未改动它；`anthropicCommitBoundaries`/Anthropic adapter 的 `classify()` 同样在合并前后未变。**因此这不是 Task 37 接缝合并引入的新缺陷，而是集成前就存在、被本轮取证撞见的既有缺陷**——但它直接违反冻结契约「adapter/candidate wrapper 保持显式 projection 边界，不丢弃已分类的 outcome」（committed H2 outcome 被整个丢弃，替换为错误的 truncation-retry 路径），故仍判 I9 VIOLATED，只是**根因不在本轮合并**。
- **对既有回归测试覆盖面的核实**：`tests/pipeline/buffered-sink.unit.test.ts:320`（"H2 ... commits — NOT retried as truncation"）与 `tests/anthropic/anthropic-v4.http.test.ts:403`（"H2: terminal upstream error SSE frame"）都**只覆盖 live 路径或裸 driver 单元测试**（后者用手工构造的 `tracker.sawUpstreamError` 回调，绕过了真实 `mergeCandidateResponseOpts` 与真实 Anthropic adapter 的 `classify()`），**没有一条覆盖「真实 handler + 真实 generation binding + 真实 Anthropic adapter + 缓冲重试路径」的组合**——这正是判据缝隙（`gaps-between-criteria-not-within` 的实例）：单看每层都有测试，合起来漏了一整类。
- **建议处置**：**BLOCKER**（真实生产缺陷、有真实 HTTP 端到端复现）。建议路由：根因位置已明确定位到 `driver.ts:987-1017`（`mergeCandidateResponseOpts` 缺少 `commitBoundaries` 重组分支）与 `delivery/adapters/anthropic.ts:47-81`（`classify()` 缺 `case "error"`），**建议交 implementer 按裁决修复**（两处二选一或都改：①在 `mergeCandidateResponseOpts` 里补 `commitBoundaries` 的 OR 组合重组；②在 Anthropic adapter 的 `classify()` 里给 `type:"error"` 加显式分支产出 `response-terminal`/`unit-close`），具体选哪种修法需要主会话或该模块 owner 裁决（涉及冻结契约的 grammar 语义，不应由验证者代为决定）。新增探测测试 `tests/pipeline/i9-h2-buffered-probe.http.test.ts` 建议保留作为回归门（当前处于红态，需实现方修复后转绿）。

## I11 — errorFrameCanonicalRewrite 的非 error passthrough 断言 provenance:"preserve"

- **判定**：HOLDS。
- **证据**：`src/lib/codec/anthropic/error-frame-canonical-rewrite.ts:53-54`——`transform` 对非 `event:"error"` 帧调用 `preserveFrame(frame)`；`preserveFrame`（`src/lib/pipeline/rewrite-registry.ts:88-90`）返回 `{ kind: "emit", frames: [frame], provenance: "preserve" }`。测试 `tests/codec/anthropic/error-frame-canonical-rewrite.unit.test.ts:53-56`（"non-error frame → emit unchanged (passthrough)"）直接断言 `action` 深等于 `{ kind: "emit", frames: [{...}], provenance: "preserve" }`，与集成者记录的迁移提交 `1ca35e35` 描述一致。
- **鉴别力正控**：现有测试即为强正控（`toEqual` 深比较整个 action 对象，任何把 `provenance` 改成别的值或省略都会导致该测试红）；命令 `bun test tests/codec/anthropic/error-frame-canonical-rewrite.unit.test.ts` 实测 `10 pass / 0 fail`（未再单独注入变异，因 `toEqual` 深比较本身已是最强形式的鉴别力，改动该字段值必然触发失败）。

## 总表

| ID | 判定 | 严重级别 | 一句话 |
| --- | --- | --- | --- |
| I1 | HOLDS | MAJOR（判据缺口） | rich carrier 到达 History capture 未扁平化，但无运行时断言守护该点 |
| I2 | HOLDS | INFO | direct render 仅在 emit 边界投影，变异正控确认 |
| I3 | HOLDS | INFO | post-render gate 只收 wire frame，变异正控确认（与 I2 共用正控） |
| I4 | HOLDS | INFO | 分类恰好一次，人工调用链枚举 + 变异正控（重复分类）确认 |
| I5 | HOLDS | INFO | classify+yield 先于 finish verdict，变异正控（顺序反转）确认 |
| I6 | HOLDS | INFO | public 边界扁平化，底层原语穷尽覆盖 |
| I7 | HOLDS | INFO | client frame 不复制 parser provenance，构造逻辑 + 既有穷尽测试确认 |
| I8 | HOLDS | INFO | Task 4 未提前实施，交付物清单逐项核实均未落地；独立否定视角 B 的 BLOCKER |
| I9 | **VIOLATED** | **BLOCKER** | H2 上游 error 帧在真实 handler+buffered 路径被误判为 truncation 重试 4 次而非 commit+fail 一次；根因在 `driver.ts` 的 `mergeCandidateResponseOpts` 缺少 `commitBoundaries` 重组 + Anthropic adapter `classify()` 缺 `error` 分支；真实 HTTP 端到端复现，非合成变异；根因预存于合并前，本轮取证撞见 |
| I10 | HOLDS | INFO | driver 不再二次 merge，变异正控（还原 pre-6aab6de4 逻辑）确认 |
| I11 | HOLDS | INFO | 非 error 帧断言 `provenance:"preserve"`，既有深比较测试即最强正控 |

## 最终 verdict

**存在阻断缺陷（1 BLOCKER / 0 major）。**

I9 是真实、可复现、非合成注入的生产缺陷：Anthropic 的 L2 buffered-retry 路径在收到上游终态 `error` 帧（H2，clean drain 无 `message_stop`）时，未按 spec（`docs/spec/2026-07-11-block-level-buffered-retry.md:152`）与 handler 自身注释承诺的行为提交并失败，而是被误判为传输层截断（truncation）耗尽全部重试预算。这违反冻结契约 I9（"adapter/candidate wrapper 保持显式 projection 边界，且不丢弃已分类的 outcome"）——committed H2 outcome 被整个丢弃、替换为错误的重试路径。

**根因不在本轮 Task 37 接缝合并本身**（`mergeCandidateResponseOpts` 与 Anthropic adapter 的相关代码在 `bd6afab5` 合并前后逐字节未变），但它是被本轮取证首次撞见的、当前 `638f6f3c` 树上仍然存在的真实缺陷，且与本轮復审目标（I9 冻结契约）直接相关。

**建议路由**：根因位置已明确（`src/lib/pipeline/driver.ts:987-1017` + `src/lib/pipeline/delivery/adapters/anthropic.ts:47-81`，见 I9 详细记录的两个修复候选点），建议交 **implementer** 按裁决修复（具体选哪种修法——重组 `commitBoundaries` 还是给 adapter 补 `error` 分类分支——涉及冻结契约的 grammar 语义取舍，建议先由主会话/该模块 owner 裁决方向）。新增探测测试 `tests/pipeline/i9-h2-buffered-probe.http.test.ts` 当前处于红态，建议保留作为修复验收门。

其余 I1–I8、I10、I11 全部 HOLDS，其中 I1 标记一个 MAJOR 级判据缺口（History capture 的 rich-carrier 不变量缺乏运行时断言守护，见 I1 记录的建议处置）。

## 工作树状态

`git status --porcelain` 结束时：仅本报告及本次新增的验证资产（`tests/pipeline/i9-h2-buffered-probe.http.test.ts`）为新增未跟踪文件；`docs/todo/deferred-backlog.md`、`docs/tmp/2026-08-09-task37-seam-review-{claims,dispositions,drift}.md` 是协调者本人的在途工作，本次会话未触碰。三处曾用于鉴别力正控的临时变异（`src/lib/pipeline/stream/response-processor.ts` 两次、`src/lib/pipeline/driver.ts` 一次、`src/lib/pipeline/generation/candidate-response-session.ts` 一次）均已用保存的原始副本精确复原并以 `git diff --stat` 确认为空。

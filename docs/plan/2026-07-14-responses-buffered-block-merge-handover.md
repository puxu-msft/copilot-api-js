# Responses buffered-merge —— 执行接手文档（handover）

- 日期：2026-07-19
- 上游：[spec](2026-07-14-responses-buffered-block-merge.md 的同目录 spec)、[plan](2026-07-14-responses-buffered-block-merge.md)（36 task，已对齐 master HEAD、过 GPT 复核 0 blocker）
- 本文档：给**新会话**接续执行用。旧会话在极长的 SDD 全流程 + 一次大重接地后，执行到 Phase 0 中段主动交接（上下文经济）。

## 当前状态（都在 worktree 分支上）

- **worktree**：`.worktrees/responses-buffered-block-merge`，分支 `feat/responses-buffered-block-merge`（从 master `65bf6714` 切，含全部 spec/plan 提交）。依赖已装（含 `@ai-sdk/openai@4.0.16`）。
- **已完成并提交的 task**（`git log --oneline master..HEAD`）：
  - Task 0.1 `@ai-sdk/openai` dev 依赖 + smoke（`6c12b0ff`）
  - Task 0.2 `reasoning_text` 独立轨道类型（`fb24f68d`）
  - Task 0.2b `output_text.annotation.added` 类型（`edc79a8d`）
  - Task 0.3 块型 fixture 模块 `tests/responses/fixtures/buffered-merge-blocks.ts`（typecheck 过；含漂移注记）
  - + plan 进度标注提交
- **Phase 1 完成**（Task 1.1-1.4，`f3af7e1c`..`fc9ba0b4` 之后）：候选托管 `transformBufferedFlush` 缝接入 driver `flushBufferedFrames` 咽喉（types.ts + candidate-response-session.ts + driver.ts 三 flush 点各传 cause）、R1 字节等价显式锁、buffered⊥hedge 特征化测试。**R1 回归绿**：anthropic/responses buffered 20 pass/0 fail、tests/pipeline 721 pass（3 pre-existing）。
- **backlog（执行期发现，低优先）**：Task 1.4 的 buffered⊥hedge 测试是 characterization、**不隔离** retryCap 短路（`makeBufferedHarness` 不建 generation binding → `!binding` 前置守卫先短路、retryCap 那行不被触达、mutation 不咬）。真正 teeth-ful 的隔离测试需 binding-present harness。不变量本身由 binding-absence + retryCap 双重防御保证。见 `methodology-plan-red-green-mutation-prediction-can-be-wrong-verify` 记忆。
- **typecheck 绿**。
- **基线（零代码改动时）**：`5606 pass / 8 pre-existing fail`。8 个失败**全是 master 既有缺陷**（无关区域：History V3 store/semantic ×4、reactive-retry e2e、offline-replay e2e、keepalive buffered-anchor e2e、P0-T1 generation runtime baseline）。执行期**只把新增失败当自己的**；改动后重跑确认没让这 8 个变更糟（尤其后 2 个靠近本特性区域）。

## 剩余 task：Task 0.4 → Phase 1-5

按 plan 逐 task 走 TDD。**几个执行期已发现、必须注意的真实缺口**（plan 示例代码在这些点与真实文件不符，别盲抄）：

1. **Task 0.4 harness 漂移（承重）**：plan 的 Task 0.4 示例用 `serveInProcess(scriptedUpstream([...]))` / `finalOf(server, MODEL)` / `completedFull([...])`，但**真实探针文件** `tests/e2e-client/responses-nodelta.probe.it.test.ts` 的 helper 是：`serveInProcess()`（无参、beforeAll 调一次）、`finalOf(frames: Array<string>)`（内部 `scriptedUpstream(() => createSseResponse(frames))` + `setUpstreamFetchForTests`）、`completedFull(seq: number, output: Array<unknown>)`、帧是**字符串 SSE**（`ev(obj)→string`）。而 Task 0.3 fixture 产出 **ClientFrame 对象** `{event, data}`。**消费 fixture 前须加适配器**：`const frameToSse = (f: ClientFrame) => \`event: ${f.event}\ndata: ${f.data}\n\n\``，然后 `finalOf([created(), ...fx.frames.map(frameToSse), completedFull(seq, [fx.finalItem])])`。DANGER 用例（mutant 去掉 `content_part.added`）断言真实 openai SDK 抛 `missing content`。
2. **Phase 5 的 Task 5.2/5.3/5.4**：plan 明确要求「先完整读 `tests/responses/responses-buffered.it.test.ts`（约 650 行）再动手、照抄其真实 harness」——同类漂移风险，别照 plan 里的骨架臆测。
3. **Task 3.3 已在 plan 里修好**（`recordBufferedMergeInfo` 不用已删除的 `request.context_updated` 总线事件、镜像 `recordSendMessageNormalization`）——按 plan 现文落地即可，别按「发布总线事件」的直觉写。

## 承重架构合同（spec §4/§5.4/§6 冻结，plan Architecture 节详述）

- **reducer 托管进 candidate-response-session 候选本地 state**（与 `acc` 并列），**不是**顶层 `RunBufferedOpts.bufferedMerge`。`observe` = 既有候选 `onRenderedFrame`；**无 `resetAttempt`**（每次 recovery 换全新候选天生 fresh）。`transformBufferedFlush` 作候选 responseOpt、driver 在 `flushBufferedFrames` 咽喉（`driver.ts:1060`，三点 retreat@1155/块级@1193/终结@1250）经 `candidateOpts` 调用，与既有 `commitBoundaries` 同构。`cause` 三点另传（与 `isTerminalFlush` 正交）。
- **buffered ⊥ hedge 互斥**（`driver.ts:768`）：reducer 永不与并发候选共存，Phase 1 加守卫测试。
- **两正交旋钮** `responses.buffered_merge.{event_compaction: verbatim|drop-delta|item-summary, completed_output: upstream|repair-if-incomplete|rebuild}`，默认 `drop-delta`/`repair-if-incomplete`。
- **合成标记仅生成帧**（repair/rebuild 的 completed 才打 `tagFrameSynthetic(f, "buffered-terminal-repair")`）；4 站点：`frame-origin.ts:29` + `model-operation-record.ts:28` + `client-sink.ts:194`(HTTP) + `client-sink.ts:588`(WS)。
- **地雷不变量**：任何依赖 content part 已存在的事件（各 `.done` + `output_text.annotation.added`）须保留其 `.added`；`item-summary` 塌缩纯 item 级时一并丢 `annotation.added`。**drop-delta 只丢有绝对值 `.done` 重设的 delta，绝不丢 payload delta**（audio/image）。
- **live-GHC 实测**：GHC 直连 completed 携完整 output → backfill 防御性非承重；message 有完整 content_part 生命周期。

## Kickoff prompt（复制给新会话）

> 继续执行 `docs/plan/2026-07-14-responses-buffered-block-merge.md`，从 Task 0.4 起。先读本 handover（`docs/plan/2026-07-14-responses-buffered-block-merge-handover.md`）+ plan 的 Architecture 节 + spec §4/§5.4/§6。已在 worktree `.worktrees/responses-buffered-block-merge`（分支 `feat/responses-buffered-block-merge`），Task 0.1/0.2/0.2b/0.3 已完成提交、typecheck 绿、基线 8 个 pre-existing 失败已归档。按 TDD 逐 task（写失败测试→跑证失败→最小实现→跑证通过→显式 pathspec commit）。注意 handover 列的 3 个 plan-vs-真实文件漂移点（尤其 Task 0.4 harness 需 ClientFrame→SSE 适配器）。Phase 1（driver 咽喉手术）是精细核心，改后必重跑 `tests/pipeline/*` + buffered 相关全绿确认 CC/Anthropic 零影响（R1）。上下文经济：36 task 体量建议用 `superpowers:subagent-driven-development` 每 task 派 subagent，或分多会话 inline。收尾走 `superpowers:finishing-a-development-branch`。

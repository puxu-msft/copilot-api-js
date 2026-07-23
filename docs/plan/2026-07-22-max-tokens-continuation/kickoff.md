# Kickoff: max_tokens 续传（max-tokens continuation）实施

复制以下内容开新会话启动实施。

---

你要实施「`max_tokens` 续传」特性。**先读**（按序）：

1. 权威 spec：`docs/spec/2026-07-22-max-tokens-continuation.md`（什么/为何，单一事实源，已三轮异模型对抗审查 + 第三轮聚焦确认 + P0 blocker 修正一轮，plan-ready）。
2. 计划总览：`docs/plan/2026-07-22-max-tokens-continuation/README.md`（DAG + 冻结契约 + Global Constraints，**含本计划自身两轮审查的修订记录**）。
3. 本计划的两轮异模型审查报告（务必读，理解哪些坑已经踩过并修正）：`docs/plan/2026-07-22-max-tokens-continuation/plan-review-gpt.md`（第一轮）+ `plan-review-gpt-round2.md`（第二轮，聚焦确认）。
4. 姊妹底座 spec + ADR（本特性复用其机制、触发路径不同）：`docs/spec/2026-07-22-continuation-retry-and-sequential-anchor.md` + `docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md`（ADR D3：完整 interactive tool_use 不续、thinking 不作前缀——**硬约束勿违**）。
5. 姊妹计划的教训清单（本特性会重演类似风险，务必对照）：`docs/plan/2026-07-22-continuation-retry-sequential-anchor/plan-2b-continuation-executor.md` §10（C3 offset 数据源、C4 生产接线、Important-1 帧变换挂载点、Important-2 retryNextStrategy 消费）。

**执行环境**（项目 CLAUDE.md concurrent-sessions + protect-user-main-server，由主会话决定 worktree 隔离方式）：
- **绝不碰 4141**；测试服务器起非-4141、按 PID 精确清理。不跑 `bun run start/dev`。
- 细粒度 pathspec 提交（`git commit -- <精确路径>`，conventional commits，无模型署名）。

**实施顺序（gate-first + matrix-first + 前置任务先行）：**
1. **先跑门簇** `plan-G-gates.md`（门 A/B/C/D/E）。**门 D（transparent/marker 统一抑制契约被 SDK 接受）是 P1 的硬依赖，必须先过**；门 B 已改为方法论冻结版（固定 prompts+schema+≥20 样本+可重复等价 oracle，产出观测分布而非临时阈值——是否 opt-in 的裁决权在用户）；门 C 决定 P2.3 是否落地；门 E 决定 P3 CC/Responses 的 B 类覆盖范围。
2. `plan-0-classifier-and-observability.md`（**独立 per-format terminal observer，本阶段 Anthropic-only** + 分型判定器 + 观测层，纯识别零续写，可独立先行、甚至可与门簇并行）。**关键一**：分型判定的数据源是**新建的 observer**，绝不能复用姊妹的 `committed-blocks-ledger`（第一轮审查抓出的 blocker，spec §11/§5.2 已同步修正——ledger 丢弃 thinking、只记已提交块，无法区分 A'/B/B-closed/C）。**关键二（round-2 修订）**：P0 范围**收窄为 Anthropic-only**（实测唯一已观测人群），CC/Responses 的 observer 落地移到 P3（Task 3.0a/3.0b）——这是诚实分档，非砍范围，别在 P0 阶段试图给 CC/Responses 建无消费者验证的接口草图。本阶段须把 `enabled:false` 时的分型 telemetry 接到**真实 terminal 调用点**（Anthropic handler 正常终止分支），不能只加类型槽位。
3. `plan-M-terminal-ownership-matrix.md`（**两轮审查共同点名的首要交付物**——已从路由决策代码逐条枚举全部运行时可达 leg，含 direct/translate/fallback/reverse/WS，非只 4 个同格式直连格。Anthropic direct 已在 planning 期确认可直接用；Responses reverse leg **已定论**为「本版本不支持」（round-2 亲自读取 `responses/handler-v4.ts:576-645` 确认走 `runResponseSink`，非待核实）；CC/Responses direct/via-responses/fallback 各格待 P3 Task M.1 补全）。
4. `plan-provenance-prerequisite.md`（**独立前置任务，非顺手项**——synthetic `continuation` provenance 标记；本 planning 期已核实姊妹的同名 backlog 仍未 landed，本特性须独立实现，`plan-1` Task 1.4 依赖其产出）。
5. `plan-Q5-three-way-overlap.md`（**独立前置任务**——续写×顺序 anchor（若开启）×重复截断（若已合并 master）三方叠加的 index 账/挂载层次/预算账时序图 + 至少一个生产 oracle。**round-2 修订**：index 账已按 master `driver.ts:1145-1149` 真实计数逻辑重画——anchor 帧从不计入 `wireDeliveredBlocks`（走 `sink.writeAnchor` 直接写出，不经过计数循环），正确序列是 `anchor@0 → real@1 → continuation@2`（两层独立 remap 链式组合），**不是**"续写 offset 内含 anchor 占位数"；`plan-4` 的 merged-state review 以此图为对账标准，非要求 reviewer 临场重新推导）。
6. `plan-1-anthropic-continuation.md`（Anthropic direct A 类续写，依赖 P0 + M-Anthropic格 + Provenance + 门 D + 门 A）——**settle 时序拆两个独立 oracle**（Task 1.1a driver-integration + Task 1.1b handler/in-process，不能只用一层测试断言两层行为）；**组合校验（`resolveEffectiveMaxTokensContinuation`）从 Task 1.2/1.5 首个可启用 commit 就消费**，不留到 P2；**新增 Task 1.6：`strategy-prevented-stitch` 真实落盘 + telemetry readback**（round-2 残留项，非仅内存诊断）。
7. `plan-2-visibility-and-budget.md`（`marker` 策略完整实现——**与 transparent 同样抑制首轮终止符，只是多注一个标记**，非独立机制；B/C 类门后扩展）。
8. `plan-3-cc-responses.md`（**Task 3.0a/3.0b 是本阶段硬前置**——CC/Responses terminal observer 落地，`plan-0` 分档决策的直接后续；随后 CC direct / CC via-responses / Responses direct / Responses fallback / Responses WS 接入，依赖 M 矩阵全部相关格补全 + 各自门；**Task 3.12 补 Responses reverse leg 的透传 producer oracle**，已定论非待核实）。
9. `plan-4-closeout.md`（非流式 backlog 登记 + doc-sync + ADR + merged-state 审查（以 Q5 时序图为对账标准，含 provenance 真实接线核实）+ 收尾）。

**方法（`superpowers:subagent-driven-development` 推荐）：** 每 task 独立 subagent + 两阶段审查（no-self-review）；异模型 reviewer 审 Claude 产出，prompt 显式写裁判轴（长远正确 + 完整，非 ROI/YAGNI）。TDD 逐 task；每 task 末显式 pathspec commit。

**承重纪律（务必守，含本轮修订新增项）：**
- **不缩减 spec 范围**：A/B/C 三分型 + 三 visibility 策略 + 独立预算 + PoC 门分档全覆盖；门 FAIL 的分型/格式回退透传 + 登记 backlog，不静默砍需求。
- **分型数据源是独立 observer，不是 ledger**（第一轮修订的核心修正，务必牢记，别把这条读漏）。
- **P0 是 Anthropic-only 分档，CC/Responses 的 observer 移到 P3 Task 3.0a/3.0b**（round-2 修订）——不要在 P0 阶段给 CC/Responses 建无实现、无消费者的接口草图；也不要在 P3 忘记这是硬前置，CC/Responses 续写的一切都要先有 observer。
- **不重复发明姊妹机制**：`hasCompleteInteractiveToolUse`/`ContinuationRequestBuilder` registry/`continued` verdict/`coordinator.runContinuation` 全部复用，本特性只新增触发点（成功路径截获）+ 独立分型判定 + visibility 策略层 + provenance 机制（因为姊妹尚未实现）。
- **触发点是成功路径，不是错误路径**：`driver.ts:1401-1453`（姊妹 cut-path）与本特性的截获点（`driver.ts:1336` 附近的 terminal drain 分支）是**互斥的不同代码路径**，不可混淆或试图复用同一个 `canContinue` 判据。
- **B-closed 恒不续写**（ADR D3，完整 interactive tool_use 是合法轮边界）；**thinking 无 `continue` 选项**（只有 `retry_with_budget` 重发，非续写）。
- **visibility×class 组合矩阵校验从 P1 首个可启用 commit 就生效**，不存在"P1 落地到 P2 才补校验"的协议违规窗口期；**且该次降级必须真实落盘 + telemetry 可查**（`strategy-prevented-stitch`，round-2 残留项，不是只在内存里降级就算数）。
- **marker ≠ 不抑制**：marker 是 transparent 的严格超集，实现时复用 transparent 的抑制机制，不要重新发明一套"不抑制只追加"的逻辑（那是已被审查纠正的错误理解）。
- **settle 时序须两个独立 oracle**：driver 级测试证明"内部循环不 return"；handler/in-process 级测试证明"`ctx.complete()` 只调用一次、verdict 正确"——两者不能互相替代。
- **后端忠实、前端选择性呈现**：`perRoundStopReason`/`clientVisibleStopReason` 必须并存，用独立 history oracle（真实持久化读回，非手动 round-trip）验收，不接受"客户端看起来对就行"的自证；synthetic provenance 同理，须真实持久化读回验证，不接受测试 fixture 手工挂字段。
- **terminal ownership matrix 是全 leg 枚举**：不能只证明 4 个直连格就自称覆盖全部，translate/fallback/reverse 各自需要单独归类（可挂载/本版本不支持/不适用）；**Responses reverse leg 已定论为「本版本不支持」，不是「待核实」**——round-2 已亲自读取完整函数体确认走 `runResponseSink`，别再花时间重新核实这一项。
- **Q5 index 账：anchor 帧从不计入 `wireDeliveredBlocks`**（round-2 修正的核心事实）——两层 remap（anchor +1、续写 offset）是独立、链式组合，不是"续写 offset 包含 anchor 占位数"；正确序列 `anchor@0 → real@1 → continuation@2`。实现 Task 1.2 时须显式处理"anchor 状态在续写 leg 是否重置"这个 master 代码自己标注的 untested corner（`driver.ts:1026-1027`）。
- **默认 `enabled:false` → 零行为变更**：每个阶段的 R1 式底线，golden 字节等价验证。
- **wire 正确性用真实 SDK oracle**（`@anthropic-ai/sdk`/`openai` 官方 SDK，非仅宽容的 `@ai-sdk`）；flaky/时序连跑 10-25 次；裁决实测 > 文档 > 声称。
- **Gate B 分型决策不用临场阈值**：固定方法论产出观测分布，是否 opt-in 交给用户在观测数据基础上裁决。

**主目标验收：** Anthropic direct A 类续写 opt-in 后，客户端看到干净的 `end_turn`（transparent 默认），后端 history 完整记录真实每轮终止 + 真实 synthetic provenance（非 fixture 手工挂）；`enabled:false` 时零行为变更（golden 回归验证）；`enabled:false` 时 Anthropic 分型 telemetry 已能通过真实 terminal 调用点观测（P0 独立验收标准，不依赖续写机制本身）；非法 visibility×class 组合配置的降级真实落盘可查（`strategy-prevented-stitch`）。

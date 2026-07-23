# Plan-4: 非流式挂载点 + 收口

> 依赖：P0-P3 全部完成（或部分完成 + 对应 backlog 登记）+ `plan-provenance-prerequisite.md`（须已收口，backlog 条目已关闭）+ `plan-Q5-three-way-overlap.md`（时序图 + oracle 已产出，供本文件 Task 4.4 引用）。目标：非流式路径的独立第二挂载点（N2 spec 明确列为 backlog，不阻塞流式路径落地）；doc-sync；ADR 定稿；merged-state 审查。

**Files：**
- Create: `docs/todo/2026-07-22-max-tokens-continuation-non-streaming.md`（N2 backlog 条目，非实现）
- Modify: `docs/DESIGN.md`（活的架构现状表新增一行）
- Modify: `docs/streaming.md`（若涉及流式契约变更）
- Create: `docs/decisions/2026-07-23-max-tokens-continuation.md`（ADR，挂靠 `2026-07-05-internal-tool-security-posture` + `2026-07-05-richest-data-flow`，spec §16.1 doc-sync 待办已预告）

---

### Task 4.1: N2 非流式 backlog 登记（不实现，只登记）

> spec §8.4 明确「首版不做」。非流式 max_tokens 同样常见（`max_non_streaming_output_tokens` 更低、更易撞），但走 `runResponseWhole`、不经流式续写循环——独立第二挂载点。

- [ ] 写 `docs/todo/2026-07-22-max-tokens-continuation-non-streaming.md`，按项目 backlog 文档格式（根因/现状/理想架构/为何暂缓/若做需改什么），内容参照 spec §8.4 的分析，补充「若做需改什么」的具体挂载点（`runResponseWhole` 的调用方 + 非流式响应的分型判定复用 P0 判定器但输入源不同——非流式响应无 wire 块序列，需要从最终 JSON 的 `content` 数组反推最后块类型）。
- [ ] **提交** → `docs(backlog): defer non-streaming max_tokens continuation (N2)`。

### Task 4.2: doc-sync

- [ ] `docs/DESIGN.md` 「活的架构现状」表新增一行（参照姊妹条目的格式：状态 `[wip]`/`[done]` + 当前活的架构一句话总结 + 涉及文件指针）。
- [ ] 若流式契约有变化（如 `[DONE]`/`response.completed` 的延后发出时序），同步更新 `docs/streaming.md`。
- [ ] `docs/todo/deferred-backlog.md` 若有新的暂缓项（门 B/C/E FAIL 产生的 backlog），逐条登记（根因/现状/理想架构/为何暂缓/若做需改什么，缺一不可）。
- [ ] **提交** → `docs: sync max_tokens continuation landed state to DESIGN/streaming/backlog`。

### Task 4.3: ADR 定稿

- [ ] 新建或挂靠 `docs/decisions/2026-07-23-max-tokens-continuation.md`，记录关键决策：transparent 默认可见性（用户不在乎双计费/下游预算约束）、后端忠实记录独立于呈现层、C 类 `retry_with_budget` 允许抬预算（N3 铁律相应放宽为可配置）。挂靠 `2026-07-05-internal-tool-security-posture`（decision 触及"proxy 不为维护 client 预算契约负责"）+ `2026-07-05-richest-data-flow`（双轨呈现原则）。
- [ ] **提交** → `docs(decisions): finalize max_tokens continuation ADR`。

### Task 4.4: merged-state 异模型对抗审查

> **修订记录（2026-07-23）**：审查重点②增补"防止实现漂移未同步回 M 文档"须覆盖全 leg 枚举（非仅原 4 格）；新增⑥核实 provenance 前置任务的产出是否真实生产接线（非测试 fixture 手工挂字段）；新增⑦以 `plan-Q5-three-way-overlap.md` 的时序图为对账标准，而非要求 reviewer 临场重新推导三方交互。

> **不自审**——按项目纪律，审查永远派 subagent，多视角对抗。派 reviewer（Claude 或 GPT 侧均可，倾向异模型对既往实现方）审查合并态：
- 显式写裁判轴：长远正确 + 完整（非 ROI/YAGNI）。
- 审查重点：① settle/finalize 时序契约是否真的如 Plan-1 Task 1.1a/1.1b 假设的那样安全（这是本计划最脆弱的架构假设，必须独立验证非自证，两个独立 oracle 是否都真的覆盖了各自该覆盖的层次）；② terminal ownership matrix 全 leg 枚举是否在实现后仍与矩阵文档一致（防止实现漂移未同步回 M 文档，含 translate/fallback/reverse legs 的透传 producer oracle 是否真实存在且通过）；③ visibility×class 组合矩阵校验是否有遗漏组合，且校验是否真的在 P1 首个 commit 就生效（非事后补丁）；④ 后端忠实记录（`perRoundStopReason`）是否真的独立于客户端可见性（用独立 history oracle 断言，不接受"客户端看起来对就行"的自证）；⑤ 跨 C3/C4 同构风险类比姊妹教训是否被正确规避；⑥ synthetic provenance 标记是否真实接线（读真实持久化 entry，非测试 fixture 手工构造，核对 `plan-provenance-prerequisite.md` 的 Task P.3 验收标准）；⑦ 以 `plan-Q5-three-way-overlap.md` 的时序图为对账标准，核实实现是否与该图一致（若发现实现偏离时序图但功能正确，须更新文档追认；若实现有图未预见的冲突，须报告为发现）。

- [ ] 收到审查报告后，逐条核实（不盲信 reviewer 断言，亲自对照 file:line）。
- [ ] 处理发现，记录未采纳项及理由。
- [ ] **提交** → `docs(review): merged-state adversarial review for max_tokens continuation`（若有修复提交则单独按语义单元提交，审查报告本身可附在 commit message 或落盘 `docs/spec/` 同目录）。

### Task 4.5: 会话收尾（session-closeout）

- [ ] subagent audit（Task 4.4 已覆盖，若有额外范围在此补）。
- [ ] doc-sync 交叉验证（grep 全仓确认文档间无矛盾引用）。
- [ ] 归档本计划文档（若适用——本计划仍在 `docs/plan/` 主目录，非 archive，除非被要求迁移）。
- [ ] 提炼教训写入项目 memory（若本计划实施过程中发现了姊妹机制之外的新教训，如 CC `[DONE]` 时序的具体坑，值得记忆库沉淀）。
- [ ] 细粒度阶段提交（本计划全程要求，非收尾时才做，此处是最后核对）。

---

## 全局验收标准（本计划完成的定义）

1. `enabled:false`（默认）时，全部已实现格式的 max_tokens 透传逐字节等价于本计划实施前的行为（golden 回归 0 差异）。
2. Anthropic direct A 类续写 opt-in 后：客户端默认看到干净的 `end_turn`（transparent），后端 history 完整记录真实每轮终止 + 真实 synthetic provenance（非 fixture 手工挂）。
3. CC direct / CC via-responses / Responses direct / Responses fallback 四格的 A 类续写覆盖（除非各自 PoC 门 FAIL，此时对应格式 backlog 登记 + 透传兜底）。
4. Responses-WS 视姊妹依赖落地状态，可能收口于 backlog 状态（不算失败，是诚实依赖边界）；`openai-responses×/v1/messages`reverse 格的核实结论已归类（可挂载则实现，否则透传 oracle）。
5. B/C 类默认透传；门 B（观测分布 + 用户裁决阈值）/门 C PASS 的部分按 Plan-2 Task 2.2/2.3 落地为 opt-in。
6. visibility×class 组合矩阵的配置校验从 P1 首个 commit 就全程生效，无静默吞配置的路径。
7. terminal ownership matrix **全 leg 枚举**文档与实现一致（Task 4.4 审查项，含 translate/fallback/reverse legs 的透传 producer oracle）。
8. 分型 telemetry counter 独立于续写开关都能观测，且经真实 terminal 调用点驱动（P0 已验收，此处确认全流程未被后续改动破坏）。
9. synthetic `continuation` provenance 标记真实生产接线（`plan-provenance-prerequisite.md` 已收口，backlog 条目关闭）。
10. Q5 三方叠加时序图 + 至少一个生产 oracle 已产出（`plan-Q5-three-way-overlap.md`），且被 Task 4.4 的 merged-state 审查引用为对账标准。

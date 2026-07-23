# 第三轮聚焦确认：`max_tokens` continuation spec

**评审范围**：仅复核上一轮 3 个 MAJOR 是否被修订版真正闭合：B-closed 回合边界、`visibility:passthrough` 与同流 continuation 的组合语义、terminal ownership matrix 的计划交付物定义。

**已核实证据**：`/home/xp/src/copilot-api-js/docs/spec/2026-07-22-max-tokens-continuation.md` §5.2/§5.3/§6/§11；当前 master `src/lib/pipeline/driver.ts:1327-1358,1415-1423`、`src/lib/pipeline/generation/coordinator.ts:143-154`、`src/lib/context/model-operation-record.ts:246,250`。当前 spec 的提交为 `2c826b60 docs(spec): align max_tokens continuation to landed-master + 2nd review round`。

**总体 verdict**：三个 major 均已闭合。**认可该 spec，可进入 plan 阶段。**

**blocker 数量**：0。

## 聚焦确认

### [已闭合] §5.2 B-closed — 完整 interactive tool_use 不再被错误视作可自动续写的 A 类

- **问题回顾**：此前将已闭合 tool_use 后的 `max_tokens` 视为可续，可能越过 client-interactive tool_use 的合法回合边界，令模型在没有客户端执行结果/`tool_result` 的前提下继续生成。
- **修订核验**：spec §5.2:141 现在明确 `B-closed` 是“正常 client turn boundary、不续写”，要求转发 `tool_use` 和真实 `max_tokens` 终止形态，交客户端执行工具并接续；还明确 server_tool_use/非交互工具若未来要支持，必须另立分型、PoC 和 ADR，不能复用 A 类。
- **代码对照**：当前 `src/lib/pipeline/driver.ts:1415-1423` 的现有 continuation guard 要求 `!hasCompleteInteractiveToolUse(ledger.snapshot())`，即完整 interactive tool_use 已被既有主线严格阻止续写。spec 与已 landed 语义一致。
- **结论**：闭合，无残留。

### [已闭合] §6 visibility × class 组合 — `passthrough` 不再含糊地要求已终止流继续追加

- **问题回顾**：若既透传 `message_stop`/`[DONE]`/`response.incomplete`，又继续在同一 SSE 流追加 continuation，会形成双终局或终局后写帧；若悄悄不续则会吞掉 `continue` 配置。
- **修订核验**：spec §6:181-188 已明确协议前提，并给出组合矩阵：`transparent`/`marker` 可同流续写；`passthrough` 不启动续写、如实终止，配置解析必须显式拒绝或降级并在 history/telemetry 记录 `strategy-prevented-stitch`，不得静默忽略 `continue`/`retry_with_budget`。同时明确 side-channel 不在本 spec 目标内。
- **代码路径对照**：当前 `src/lib/pipeline/delivery/session.ts:155` 将 `message_stop`/`response.completed` 认作已经写出的客户端终局，`driver.ts:1327-1358` 的 terminal drain 也确实是实际写终局的路径，因此该矩阵的协议推理正确。
- **结论**：闭合。矩阵不仅指出不兼容，还规定了拒绝/降级行为及可观测性，足以让 planner 定义 config validation 与测试。

### [已闭合] §5.3 terminal ownership matrix — 不再错误把 commit boundary 当成 client terminator

- **问题回顾**：此前把“每格式 terminator 抑制点”简化成 commit-boundary 终止帧；实际 commit boundary、upstream completion detection 和 client-visible terminal emission 分散在不同层。例如 current master `driver.ts:1327-1358` 在 `sawMessageStop()` 后才 terminal-drain；现有 continuation `driver.ts:1401-1453` 只处理无终止符的 cut。
- **修订核验**：spec §5.3:152 明确区分三层，且引用 Anthropic 的 `content_block_stop/error` commit boundary 与 `message_stop` terminal drain 的不同；§5.3:154 将 plan 首要产出定义为每个 `(inbound format × outbound client format × direct/translate/fallback/WS) leg` 一格，并要求四个不可省略要素：① upstream completion 的 accumulator 记录层；② client-visible terminator 的构造者；③ transparent 截获位置（且必须在构造前）；④ continuation 最终 completion 的唯一终局写入者。
- **Anthropic direct 先行路径**：§5.3:156 已明确成功路径是 terminal drain 写客户端前的新拦截点，而不是把当前 cut-path append 当成证明；这与当前 `src/lib/pipeline/driver.ts:1327-1358` 和 :1401-1453 实际结构吻合。
- **结论**：闭合。矩阵粒度、四要素和“唯一终局”不变量足以作为 planner 的正式先决交付物；P3 在矩阵完成前不实施 CC/Responses/WS 的限制也写清楚了。

## 总体结论：可否进入 plan

**可进入 plan 阶段。**

三个被点名的 major 都已得到可执行、与 master 代码一致的闭合：B-closed 不会跨越 interactive tool boundary；passthrough 与同流 continuation 的不可组合性已有显式配置/观测语义；terminal ownership matrix 已成为计划的首要交付物而非模糊的“按格式处理”。建议计划按 spec §11 所述先产出 matrix，再实现 P0 识别观测与 Anthropic direct A 类 transparent 成功终止截获；CC/Responses/WS 仅在对应 matrix 格子和 producer/client wire oracle 明确后进入实现。
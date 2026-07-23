# 复审报告：`max_tokens` 续传 spec 修订版（2026-07-22-max-tokens-continuation.md）

> 复审者：Claude 驱动 reviewer（第二轮，承接 `-review-claude-a.md`）
> 日期：2026-07-23
> 裁判轴：长远正确 + 完整（非 ROI/YAGNI）
> 方法：亲手核对修订涉及的每个 file:line 与 wire 机制（master 工作树 + 各分支/worktree grep）

## 总体结论

**仍需修订——存在 1 项 blocker + 3 项 major。设计方向认可、上轮 4 项 major 消化良好，但修订过程中新引入了一个与上轮 `ln` 同构的伪「已核实」实证声称，且整个 §11 sequencing 依赖分析建立在被实测证伪的错误代码事实上。修正 §11 依赖分析（实为利好）+ 对齐 master 已固化的 ADR D3 约束 + 吸收已 landed 的 FINDINGS 结论后，可进 plan。**

blocker 数：1

---

## 双视角覆盖证据

**机械核对**：
- `git grep committedBlocksLedger master -- src/` —— **命中 3 文件含实际接线**（与 spec §11「零命中」相反）。
- 核对 master 上续写底座完整性：`committed-blocks-ledger.ts` / `continuation-builder.ts` / `committed-block-extractor.ts` 模块 + `driver.ts:1279/1299/1300` ledger 喂养 + `driver.ts:1412-1445` 续写触发 + `handler-v4.ts:1219-1220` 接线。
- `DispatchVerdict` / `CandidateVerdict` 定义（`model-operation-record.ts:246/250`）—— `"continued"` 值已在 master。
- `settleGenerationAttempt`（`request.ts:691`）签名类型核对。
- `exp/continuation-shape/FINDINGS.md`（master）G3/G4/G5a/G5b 全 PASS 内容核读。
- `git worktree list` —— 确认 `.worktrees/continuation-retry/` **不存在**。
- 上轮 4 项 major 逐条回归：`ln`→`committedAny`（§1.3/§5.1/§15）、§5.2 穷尽判定表、Q5 三方、§5.1 settle-freeze 升承重。

**第一人称执行模拟**：
- 假装 planner 照 §11 走 P0：按 spec「ledger 在分支、master 尚无」去「自建轻量累积器」—— 撞「master 其实已有 ledger + extractor」的无用功。
- 假装 §5.2 分型判定器遇 B-closed（闭合 tool_use）走「可续」—— 撞 master `driver.ts:1412` `!hasCompleteInteractiveToolUse` 门（ADR D3 遇完整 interactive tool_use **正常终止不续**）。
- 假装 §6 配 `thinking:"continue"` —— 撞 master extractor 已从 ledger 排除 thinking 块（无前缀可续）。
- 走 §5.3 transparent-stitch：多轮 message_delta.usage 如何合并成客户端可见的单一累积 usage。

---

## 事实性发现

### [blocker] §11 / §1.3:38 / §5.1:130 / R6 —— 续写底座已完整 landed master，spec「master 尚无/grep 零命中」被实测证伪；又一处伪「已核实」声称

证据：
- spec §11:237 原文「committed-blocks-ledger + … 该基建**仅在分支、master 尚无**，已核实 `grep committedBlocksLedger src/` on master 零命中」。实测 `git grep -l committedBlocksLedger master -- src/` **命中 3 文件**，且是**实际实现接线**非类型 stub：`driver.ts:1279` `const committedFrames = opts.committedBlocksLedger && …`、`driver.ts:1300` `opts.committedBlocksLedger.recordCommitted(block)`、`handler-v4.ts:1219` `createCommittedBlocksLedger()` + `:1220` `extractAnthropicCommittedBlocks`。
- 续写**触发侧**亦在 master：`driver.ts:1412-1445` 完整 `canContinue` 门（committedAny + continuation.enabled + ledger + budget + `!hasCompleteInteractiveToolUse`）+ `continuation.buildRequest(...)` + `coordinator.runContinuation(...)`；模块 `continuation-builder.ts` / `committed-block-extractor.ts` / `committed-blocks-ledger.ts` 全在 master `src/lib/`。
- `continued` verdict 已在 master（`model-operation-record.ts:246` `DispatchVerdict = "committed"|"discarded"|"failed"|"cancelled"|"continued"`；`:250` CandidateVerdict 同）。
- `.worktrees/continuation-retry/`（spec §11:237、§16:303/308 反复引用的路径）**不存在**（`git worktree list` 仅 feat-activity-detail-outline / history-cas-stage / monorepo-split / repetition-truncation / shadcn-redesign）。

影响：整个 §11 sequencing、§1.3「分支已铺好」、§5.1「接口仍 in-flight」、R6「依赖续写 spec 未合并」全部建立在错误前提上。**这对本 spec 实为利好**（依赖已满足），但错误陈述会误导 planner：P0 会照 spec 去「二选一自建轻量累积器」（§11:239 路线 a），而 master 已有可直接复用的 ledger + `extractAnthropicCommittedBlocks`；P1「依赖续写 spec landed」的阻塞不存在。**更严重的是问题模式**：这与上轮 `ln` 虚构同构——冠以「已核实 grep」却与实测相反。spec §297 刚用「根因=误用 `rg -r ln` 替换 flag」解释上一个错误，随即又犯同类伪实证。empirical-verification 是本项目承重纪律（`verifying-authoritative-claims`：否定/absence 断言最易凭结构推断而错），进 plan 前此章事实基础必须重核。

修复：亲手 `git grep committedBlocksLedger master -- src/` + 读 `driver.ts:1412`，据实重写 §11——底座（ledger + extractor + builder + 触发 + `continued` verdict）已在 master，P0 直接复用、无需自建累积器、P1 依赖已满足；删所有 `.worktrees/continuation-retry/` 路径引用（改指 master 或 `exp/continuation-shape/FINDINGS.md`）。

### [major] §5.2 B-closed「可续」+ §6 `thinking:"continue"` 与 master 已固化 ADR D3 冲突（复用底座须对齐既定决策）

证据：master `driver.ts:1412` 注释明载 **ADR D3**：「committed prefix has NO complete interactive tool_use（that is a legitimate turn boundary — the client runs the tool — so we terminate normally, NOT continue）」，且门含 `&& !hasCompleteInteractiveToolUse(ledger.snapshot())`。又 `driver.ts:1443` 注释「`ledger.snapshot()` already excludes thinking (extractor) — upstream rejects thinking as a prefix (ADR D3)」。即 master 既定：(1) 遇完整 interactive tool_use **不续、正常终止**；(2) thinking 块被 extractor 从 ledger 排除、**不可作续写前缀**。而本 spec §5.2 B-closed 分型称「闭合 tool_use…等同 A 语义可续」、§6 保留 `thinking:"continue"` 选项——两者都与 master 已 landed 的 ADR D3 直接冲突。spec §3.3 自己也承认 thinking 无法干净回喂，却在 §6 留 `continue`，内部张力。

影响：spec 因误以为底座「在分支/未定」，未对齐已固化的前缀策略决策。B-closed「可续」在 master 架构下会被 `!hasCompleteInteractiveToolUse` 门直接拦下；`thinking:"continue"` 对 C 类不可实现（ledger 里根本没有 thinking 块）。计划期照现 spec 会撞既定 ADR。

修复：§5.2 B-closed 改为「遵从 ADR D3、完整 tool_use 正常终止不续」（或若真要改需显式提 ADR 修订，交用户）；§6 删 `thinking:"continue"` 或标注「须先推翻 ADR D3 的 thinking-quarantine，不推荐」。

### [major] §5.2 / §8 CC「tool_calls 尾随约束叠加、默认透传」已被 master FINDINGS G5a 证伪，未吸收

证据：master `exp/continuation-shape/FINDINGS.md` **G5a PASS**：「assistant{tool_calls} 直接接 user（无 tool role）… GHC 返回正常 completion 非 400 …**OpenAI 标准的 tool_calls 尾随约束在 GHC 上不成立** → CC 续写不撞该 hazard，spec §4.3 CC 行的窄场景 partial-degrade fallback **不需要**」。而本 spec §5.2:146 / §8 CC 行仍写「多 tool_use 链非首个被截断的 CC 尾随约束叠加续写 spec §4.3，默认透传」——沿用已被证伪的旧约束。

影响：B 类 CC 透传的部分理由过时；实际 GHC 不约束、该 fallback 分支不需要。FINDINGS 同时 G4 PASS（CC 并行 tool_call index 严格串行、块边界判据成立）——本 spec §7「CC toolCallMap … 列为计划期核实项」也可据此收窄。

修复：§5.2/§8 CC 段吸收 G5a/G4 结论——CC 续写不撞 tool_calls 尾随约束；§7「per-format 核实项」引 G4 串行已证。

### [major] §5.1:130 `continued` verdict 依赖论证前提过时（已 landed + named type，非 in-flight 内联联合）

证据：spec §5.1:130「续写 spec 的 plan-2b 显示需**新增**第 5 个 `DispatchVerdict`/`CandidateVerdict` 值 `"continued"`，且类型传播（`request.ts:690-693` `settleGenerationAttempt` **内联字面量联合**…）是其 reviewer 对抗审才补漏发现的真实挡编译点…本 spec 依赖是 `continued` verdict 的**接口形状**、非二元 landed」。实测：`"continued"` **已在 master** `DispatchVerdict`/`CandidateVerdict`（`model-operation-record.ts:246/250`）；`settleGenerationAttempt`（`request.ts:691`）签名是 `verdict: DispatchVerdict`——**named type**（从 model-operation-record import，`:41`），**非内联字面量联合**。接口已定型 landed，非 in-flight。

影响：「依赖接口形状仍可能变」的论证基础不成立——接口已固化。此发现方向（依赖非二元 landed）本是好的对抗视角，但其具体代码依据（内联联合、in-flight）与当前 master 相反。

修复：§5.1 更新——`continued` verdict + settle 类型传播已 landed master、`DispatchVerdict` 是 named type（改一处定义即传播）；本 spec 的 post-success 触发复用既有 `continued` 语义即可，不再有「接口再变需同步复核」的悬置。

---

## 次要发现

### [minor] §13 未决问题重复 Q4
行 265 与 266 是**完全相同**的两条「Q4 max_rounds 默认」。机械 bug，删其一。

### [minor] §1.3:38 ledger 喂养行号为分支旧值
spec §1.3:38「driver.ts:1233 铺好 ledger 喂养 + driver.ts:1255 committed settle」—— master 实际为 `driver.ts:1279`（committedFrames 快照）/ `:1300`（recordCommitted）。分支旧行号，plan 期以 master 真实行为准。

---

## 上轮 4 项 major 消化核对（正面确认）

- **`ln`→`committedAny`**：§1.3:36 / §5.1:124 / §15:286 已全改，`driver.ts:1283` `!committedAny` 门核实一致。✓ 已消化。
- **§5.2 穷尽判定表**：改为闭合×块类型矩阵，补 A'（未闭合 text）+ B-closed + 零-delta tool_use 退化 + C「最后块==thinking」唯一判据消歧。✓ 结构良好（但 B-closed 动作与 ADR D3 冲突，见上 major 2）。
- **Q5 三方交互**：§13 Q5 已扩为错误续写 + max_tokens 续写 + 重复截断三方，列 index/挂载/预算三层账 + 时序图要求。✓ 已消化。
- **§5.1 settle-freeze 升承重**：从「核实项」升为承重架构设计项，补 finalize race + 推迟 settle vs 已 settle 补记两方案。✓ 方向正确（依赖论证的代码依据需按 major 4 更新）。

## Q1 / §4 transparent-stitch 审查

- **双轨忠实（`perRoundStopReason` + `clientVisibleStopReason`）**：自洽，richest-data-flow 对齐正确——「藏只对客户端 wire、后端记录忠实完整」是本项目 ADR `richest-data-flow` 的标准应用（后端完整/前端选择性呈现/合成物打标记）。§9 双轨并存 + attempts[] 含被抑制首轮 max_tokens + 独立 oracle 断后端（§10:227）设计到位。✓ 认可。
- **§5.3 wire 抑制机制**：首轮 terminator 抑制 + 保持流 open + 续写块 index 续编 + 真实终止符收尾——逻辑站得住，与 master 错误续写路径的中途 terminator 抑制同构。per-format 抑制点（CC `finish_reason:length` / Responses `response.incomplete`）方向正确。
- **[建议] 多轮 usage 合并 wire 细节未展开**：Anthropic `message_delta.usage.output_tokens` 是累积语义；抑制首轮 message_delta 后，续写轮 message_delta 如何把「各轮真实总和」（§4:114）合并成客户端可见的单一递增 usage、末轮 message_delta 报什么值——spec 未给 wire 级细节。门 D（§12:253 验 `output_tokens > max_tokens` SDK 不抛错）覆盖了接受性，但缝合流的 usage 单调性/最终值语义应在 plan 前补一句。预期影响：SDK 若见 usage 非单调或末值不等于总和可能误累积。

---

## 是否可进 plan

**暂不可，须先修订**。blocker（§11 依赖前提被证伪 + 伪实证模式）直接污染「进 plan」的核心输入——planner 会据错误的 sequencing 做无用功或撞已固化 ADR。这不是设计推倒，是一个承重章节的**事实基础**必须据实重核。

**修订清单（闭合即可进 plan）**：
1. [blocker] 亲手 `git grep committedBlocksLedger master -- src/` + 读 `driver.ts:1412`，据实重写 §11/§1.3/§5.1/R6——底座已 landed master、P0 直接复用、P1 依赖已满足；删 `.worktrees/continuation-retry/` 失效路径。
2. [major] §5.2 B-closed / §6 `thinking:"continue"` 对齐 master ADR D3（完整 tool_use 不续、thinking 不作前缀）。
3. [major] §5.2/§8 吸收 FINDINGS G5a（CC 无 tool_calls 尾随约束）+ G4（CC index 串行已证）。
4. [major] §5.1 更新 `continued` verdict 依赖（已 landed named type、非 in-flight 内联联合）。
5. [minor] 删重复 Q4；刷新 §1.3 ledger 行号。
6. [建议] §4/§5.3 补多轮 usage 缝合 wire 语义一句。

设计内核（三分型策略、transparent-stitch 默认 + 后端忠实双轨、独立预算、PoC 门分档）认可，方向正确。上述均为「对齐既成 master 事实 + 修正伪实证」，非结构重做。

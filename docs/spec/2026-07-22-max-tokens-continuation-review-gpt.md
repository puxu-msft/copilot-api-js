# 审查报告（异模型对抗）：`docs/spec/2026-07-22-max-tokens-continuation.md`

> 审查者：GPT 异模型 reviewer
> 日期：2026-07-22
> 评审范围：单文件 spec 草案（max_tokens 续传），对照姊妹 spec `docs/spec/2026-07-22-continuation-retry-and-sequential-anchor.md`、CLAUDE.md 项目哲学、`src/lib/pipeline/driver.ts`（master + `feat/continuation-retry` worktree 两份实况）、`src/lib/openai/translate/*` 格式映射、`src/routes/messages/handler-v4.ts` / `src/lib/pipeline/non-streaming-completeness.ts` 成功路径检测代码。
> 已读取/执行的证据：两份 spec 全文；`src/lib/pipeline/driver.ts`（master 1356 行 + worktree `.worktrees/continuation-retry` 1398 行）、`src/lib/context/model-operation-record.ts`、`src/lib/context/request.ts`、`src/lib/pipeline/generation/coordinator.ts`、`src/lib/codec/anthropic/commit-boundaries.ts`、`src/lib/openai/translate/{anthropic-to-cc,cc-to-anthropic-stream,anthropic-to-responses,responses-to-anthropic}.ts` 逐行核对全部 4 处 file:line 引用；`docs/plan/2026-07-22-continuation-retry-sequential-anchor/{HANDOFF.md,plan-2b-continuation-executor.md}`；`git log`/`git branch`/`git merge-base` 核实姊妹 spec 落地状态（分支 `feat/continuation-retry` 未合并 master，隔离于 `.worktrees/continuation-retry`）；全仓 grep 核实 `ln` 标识符是否存在（未找到，含全部 6 个活跃 worktree 与全部 git 历史提交的 `driver.ts` 各版本）。

**总体 verdict**：**存在 blocker**（1 处事实性错误必须先修正）+ 若干 major 缺口须在计划期前闭合，**不建议**在修正 blocker 前直接进用户评审；修正后可进入用户评审阶段（尚不能进计划阶段，§13 未决问题需先用户裁决）。

**blocker 数量**：1

---

## 事实性发现

### [BLOCKER] §1.3 / §5.1 / §15 术语 — `ln` 变量名系虚构，非真实重命名

- **问题**：spec 声称姊妹 spec 的重试门变量名是「`ln`（原 `committedAny`，已核实重命名）」，这是一个可核实的事实性断言，且核实结果为假。
- **证据**：`src/lib/pipeline/driver.ts:1283`（master）与 `.worktrees/continuation-retry/src/lib/pipeline/driver.ts:1325`（`feat/continuation-retry` 分支）两处实测均为 `const retryable = (thrown ? classifyStreamError(thrown) === "other" : true) && !committedAny`；全仓（含全部 6 个活跃 worktree、全部 git 历史提交对应的各版本 `driver.ts`）逐一 grep `\bln\b` 均无命中。姊妹 spec 全文也从未提及 `ln`，只用 `committedAny`。
- **影响**：spec 明确标注「已核实重命名」却实为未核实，属于本项目 `verifying-authoritative-claims` skill 反复强调的高风险模式（自证式断言未经独立核实）。若不修正，实现者会去 driver.ts 找一个不存在的标识符，也削弱 spec 其余"已核实"断言的可信度。
- **建议**：全文 3 处（§1.3、§5.1 标题+正文、§15）把 `ln` 改回 `committedAny`，或直接删除这个多余的伪重命名叙事。

### [MAJOR] §11 Sequencing — "P0 可独立先行、无依赖"与 §5.2 分型判定实现方式自相矛盾

- **问题**：§5.2 写"判定须在 commit-boundary 累积器 / ledger 上做（已知块结构），不重解析 wire"——但 committed-blocks-ledger / `extractCommittedBlocks` 是姊妹 spec §4.2 的产物，master 尚不存在（已核实：`grep -rn "committedBlocksLedger" src/` 在 master 上零命中，只存在于 `.worktrees/continuation-retry` 分支）。而 §11 却断言 P0（分型判定器 + terminal 检测 + telemetry）"可独立先行，无依赖"。
- **file:line / spec 节**：spec §5.2、§11；对照 `.worktrees/continuation-retry/src/lib/pipeline/driver.ts:1238`（`committedFrames` 依赖 `opts.committedBlocksLedger`）。
- **建议**：§11 P0 条目须明确二选一并说明理由：(a) Anthropic 端点自建独立、更轻量的累积器（不等待姊妹 spec，但需防止未来两套逻辑分叉）；(b) 承认 P0 对 Anthropic 端点其实间接依赖姊妹 spec 产物，只能先在 CC/Responses 端点（各自已有独立累积器）先行。当前写法"无依赖"与支撑细节矛盾，须在计划期前拍板。

### [MAJOR] §5.1 — "复用同结论"掩盖了姊妹 spec 该结论仍在迭代、非稳定基座的事实

- **问题**：姊妹 spec 关于续写与 hedged-candidate 语义兼容性的论证，在 `docs/plan/2026-07-22-continuation-retry-sequential-anchor/plan-2b-continuation-executor.md` 中显示仍是 in-flight 设计——需要新增第 5 个 `DispatchVerdict`/`CandidateVerdict` 值 `"continued"`，且其类型传播审计（`request.ts:690-693` `settleGenerationAttempt` 内联字面量联合）是 reviewer 对抗审查中才补漏发现的"真正挡编译点"（plan-2b `[C1 补漏]` 标记）。已用 `grep -rn "settleGenerationAttempt("` 核实该函数在 `request.ts:793/1377/1382/1493/2093` 多处被调用，均消费 verdict 字面量联合，证实这是真实的、非装饰性的接口稳定性问题。
- **file:line / spec 节**：spec §5.1；对照 `src/lib/context/request.ts:690-693,1377`。
- **建议**：§5.1/§11 应明确注明"本 spec 依赖的不仅是姊妹 spec 落地与否这一个二元状态，而是其 `continued` verdict 的具体接口形状——若该接口在计划落地前再变，本 spec 的触发点设计需要同步复核"，而非简单一句"复用同结论"。

### [MAJOR] §3.2 B 类论证第 3 点引用了姊妹 spec 已被自己实证推翻的过时状态

- **问题**：姊妹 spec 正文 §10 写"未验证：已 commit 完整 tool_use 块作 assistant 前缀是否被上游接受"，但 `docs/plan/.../HANDOFF.md` §3 记录门簇结果"**G3** Anthropic 接受『完整 tool_use 块作 assistant 前缀 + user 续写轮』→ 续写覆盖 tool_use 前缀，不限 incident 的 text-only"，即已 PASS。本 spec §3.2 第 3 点仍引用姊妹 spec 正文的"未验证"表述，未同步姊妹 spec 执行进度（HANDOFF）里已推翻的最新事实。
- **注意**：G3 验证的是"完整（未截断）tool_use 块"作前缀被接受，不等于本 spec B 类场景（截断/悬挂 partial tool_use 被丢弃后重生成）被验证——这两者不同，B 类"重生成≠续写、会发散"的论证逻辑本身仍站得住，只是所引用的支撑论据已过时。
- **file:line / spec 节**：本 spec §3.2 第 3 点；对照姊妹 spec §10、`docs/plan/2026-07-22-continuation-retry-sequential-anchor/HANDOFF.md` §3。
- **建议**：更正引用为 HANDOFF 最新状态，同时保留"G3 通过 ≠ B 类问题已解决"的正确区分。

## 主观建议

- **[建议]** §3 分型策略整体合理、基本穷尽当前实测样本模式。但存在一个未显式点名的第四种边界情形：text 块闭合后紧跟一个刚 `content_block_start` 但尚未产生任何 `input_json_delta` 就被截断的"零-delta tool_use"块。§5.2"最后块为 tool_use 且无 `content_block_stop`→B"的判据逻辑上已隐含吸收此情形，但建议显式点一句"零-delta tool_use start 视作 B 类的退化子情形"，避免实现时遗漏边界测试。
- **[建议]** §4 客户端可见性契约三候选（P1/P2/P3）基本穷尽、判断合理，倾向 P2 符合 richest-data-flow 精神。但双计费处理只覆盖了 telemetry 侧，未讨论响应体 `usage.output_tokens` 字段本身在 P2 缝合流下的呈现策略（是否会诚实反映"原预算+续写追加"、是否可能被下游误判为超预算异常）。建议在 §4/§9 补充这一具体呈现策略。
- **[建议]** §11 关于"仅分型 counter 就值得先行落地"的论证是本 spec 论证最扎实的一段，符合项目 richest-data-flow 精神，予以正面认可。
- **[建议]** §5.1 中"成功路径下 coordinator 状态能否再启新 exchange"被列为"计划期核实项"——鉴于姊妹 spec 对等价问题在实现阶段暴露了多个编译期挡点（`request.ts:690-693`、`driver.ts:653` 的 `retryNextStrategy` 消费点、`projection.ts:312` 的 `success` 投影），建议将其升级为"承重设计项"，比照姊妹 spec plan-2b 的显式类型改动清单处理，而非留一句"计划期核实"带过。

## 逐条回应对抗提纲六个重点（摘要）

1. **§3 分型策略**：A 类复用声称基本成立；B 类论证逻辑站得住但支撑证据过时（见 MAJOR）；C 类"thinking 不可续、retry-with-budget 为正确解"判断合理，(a)/(b)/(c) 选项诚实标注待 PoC 门/用户裁决；未漏主要分型，零-delta tool_use 边界建议显式点出。
2. **§4 客户端可见性契约**：确系承重决策，候选基本穷尽；双计费 telemetry 侧诚实，响应体 usage 字段侧有遗漏（见建议）。
3. **§5 触发机制**：成功路径 vs 错误路径区分方向正确（已用 driver.ts:1290/1283 核实为两条不同代码路径），但引用的变量名 `ln` 系虚构（BLOCKER）；coordinator settle 时点核实项判定为"不够"，应升级为显式设计项。
4. **§11 sequencing 硬依赖**：P0 独立先行判断与 §5.2 存在未言明矛盾（见 MAJOR），需计划期前拍板。
5. **§13 未决问题**：五项覆盖了主要分叉点，未发现遗漏或不当留白/擅定项。
6. **自相矛盾/引用错误**：1 处 blocker 级虚构引用（`ln`）+ 1 处过时引用（B 类论据）+ 1 处内部矛盾（P0 独立性 vs §5.2 依赖）；其余 4 处 file:line 引用（`anthropic-to-cc.ts:143`、`cc-to-anthropic-stream.ts:111`、`anthropic-to-responses.ts:176`、`responses-to-anthropic.ts:311`）逐一核对全部准确。

## 总体结论：是否可进入下一阶段

**不建议原样进入用户评审**。§1.3/§5.1/§15 的 `ln` 变量名断言是可核实的事实性声明且被核实为假，带着这个错误交给用户评审会误导用户对"承重区分"（§1.3 标题即是这一节）的技术判断基础；§11 的 P0 独立性论证也内部自相矛盾需先解决。这两处修正成本低但不改会误导评审，建议作者自行修正后再交评审，无需重新走完整轮次。其余发现（B 类论据过时引用、§5.1 依赖强度描述不足）建议一并顺手修正。修正后，本 spec 核心设计（三分型策略、可见性契约候选、独立预算模型、PoC 门设置）在审查范围内站得住，值得推进到计划阶段——但计划阶段开始前，§13 的 Q1（客户端可见性）与 Q2（C 类策略）仍须先经用户裁决，这是 spec 自己也承认的、非本次审查新增的阻塞项。

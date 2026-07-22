# 评审报告：`max_tokens` 续传 spec（2026-07-22-max-tokens-continuation.md）

> 评审者：Claude 驱动 reviewer（reviewer-a）
> 日期：2026-07-22
> 裁判轴：长远正确 + 完整（非 ROI/YAGNI）

**评审范围**：待审 spec 全文 + 两份姊妹 spec（continuation-retry、repetition-truncation）+ 代码锚点实测（driver.ts 的 `ln`/`committedAny` 门、ledger 喂养行、per-format max_tokens 映射、keepalive-anchor）。

**总体 verdict**：**无 blocker；存在 4 项 major，修复后可进入计划阶段**。设计方向正确、分型洞察扎实、承重决策（§4 可见性、§5.1 post-success 分支、§6 独立预算）都摆到了明面并诚实标注了依赖与 PoC 门。问题集中在「分型判定树有逻辑洞」「合并态三方交互不完整」「一处虚假实证声称」。

**blocker 数**：0

## 双视角覆盖证据

**机械核对做的扫描/对账/查证**：
- 全分支 grep `ln`/`!ln`/`committedAny` on driver.ts（master + feat/continuation-retry + 全 branch 集合）——确证 `ln` 不存在。
- 逐行核对 per-format 映射锚点：`anthropic-to-cc.ts:143`、`cc-to-anthropic-stream.ts:111`、`anthropic-to-responses.ts:176/201`、`responses-to-anthropic.ts:311`。
- 核对 `feat/continuation-retry` 分支 driver.ts:1233/1255 ledger 喂养与 committed settle 记录行。
- 三 spec 交叉对账 Q5 声称的复用/依赖关系；对照 CLAUDE.md 哲学（richest-data-flow、no silent behavior change、empirical-verification、settle-freeze 记忆）。

**第一人称执行模拟的流程/分支**：
- 假装是 §5.2 分型判定器，喂入 5 类真实终止 wire 形状 + 混合块（闭合 text 后接悬挂 tool_use）+ 未闭合 text 终止 + text 后 thinking 截断 —— 走每条 if 看落哪个分型。
- 假装是 planner，沿 §11 sequencing 走 P0→P1，在 §5.1 撞「success 已 settle、entry 已冻结、却要 attempts[] 记续写轮」。
- 假装三 spec 同 exchange 叠加：错误续写→success→max_tokens 续写，同时 repetition 截断在 delivery 层缓冲折叠，追踪 index/attempt/预算三层账。

---

## 事实性发现

**[major] §1.3 / §5.1(:119) / §15 术语 — `ln` 变量不存在，「已核实重命名」是虚假实证声称**
证据：master 与 feat/continuation-retry 分支的重试门变量均为 `committedAny`（master `driver.ts:1283`、branch `:1325`：`const retryable = (thrown ? classifyStreamError(thrown)==="other" : true) && !committedAny`）；全分支 grep `ln`/`!ln`/`const ln` on driver.ts 均无命中。spec 引用的 `!ln` 与「原 `committedAny`，已核实重命名」是捏造——姊妹 continuation-retry spec（该 branch 的权威来源）自己 §5.1 也仍写 `!committedAny` at `:1283`，两份同日 spec 互相矛盾。
影响：planner 会 grep `ln` 一无所获；「已核实」的虚假会侵蚀本项目 empirical-verification 纪律。注：§1.3 的**设计论证**（max_tokens 是 success 路径、非 error 门，故需新 post-success 分支）**不受影响**——门确实是 error-path、max_tokens 确实是 success-path。
修复：全文 `ln`→`committedAny`，删「已核实重命名」措辞。

**[major] §5.2 分型判定树有未覆盖分支 + A 类闭合前提仅 n=1**
证据（第一人称走查）：§5.2 三条规则为「已闭合且 text→A / tool_use 且无 stop→B / thinking→C」。喂入「终止时最后一个 text 块**未闭合**（无 content_block_stop）」——匹配不到任一规则（A 明确要求「已闭合」）。而 A 类安全性全押在「截断前 text 块必闭合」，但这只有 1 例实证（`_44` 是唯一 A 类样本），spec 未确立其为 Anthropic 协议在 max_tokens 时的不变量（是否总先发 content_block_stop 再发 message_delta）。
修复：补「未闭合 text 终止」的归属分支；实证或显式声明 Anthropic 在 max_tokens 时是否总闭合当前块，别把 n=1 当协议保证。

**[major] Q5 合并态交互只覆盖两方、遗漏第三方 repetition-truncation**
证据：评审点 3 明确要三方叠加；spec Q5 只画 max-tokens × continuation-retry。但 repetition-truncation spec 把有状态 client.outbound 下沉到 `delivery/session.ts` 并 eager-forward `content_block_start` + 块内缓冲折叠。三者同 exchange 时：sequential-anchor 的**运行时递增 index offset**（continuation-retry §3.3，本身是未闭合承重项）+ 续写「块 index 连续递增跨 attempt」+ repetition 的 eager-start/折叠，三层 index 账在 spec 任何处都无分析。§9 仅一句「若续写走 hook 挂载点沿用重复截断 §9」，未触及 index/挂载层次冲突。
修复：Q5 扩为三方，或显式声明本 spec 续写缝合层与 repetition delivery 层的相对次序与 index 归属。

**[major] §5.1 post-success 续写 vs success-settle 冻结的张力被低估为「计划期核实项」**
证据：成功路径在 settle 点冻结 history entry 快照（skill `persistence-async-invariants` §2、记忆 `settle 冻结 history entry`），coordinator 已 `whenModelOperationFinalized`。但 §9 要 attempts[] 记每轮续写、§5.1 要 post-settle 再启新 exchange 接同一 sink——这撞 finalize race（记忆 `V3 direct-driver async finalize race`）且已冻结记录能否追加存疑。§5.1 仅称「成功路径的 settle 时点不同——列为计划期核实项」，把架构级张力降格成一句核实。对比 continuation-retry 把同类问题（committedAny 门）升为 §5.1 承重 driver 状态机分支——本 spec 未对等处理其 success 侧变体。
修复：把它从「核实项」升为承重架构设计项，明确 settle/finalize 与 post-success 续写的时序契约。

---

## 主观建议

**[建议] §5.2 C 类双判据可冲突** — 「最后块=thinking」OR「thinking_tokens≈output_tokens 且无可见答案」两条在「已 commit text + 其后 thinking 截断」时打架：last-block=thinking 但有可见答案。默认透传本身安全，但「0 答案」表征不准、telemetry `class=thinking` 会误标有答案的场景。预期影响：诊断口径失真。建议明确两判据优先级。

**[建议] per-format 映射锚点指向 JSDoc 而非可执行 case** — `anthropic-to-cc.ts:143`、`cc-to-anthropic-stream.ts:111`、`anthropic-to-responses.ts:176` 均落在 JSDoc 注释行（实际 case 在 `anthropic-to-responses.ts:201`）；仅 `responses-to-anthropic.ts:311` 精确命中 code。预期影响：读者跳转到注释需再找 code。建议指 case 行或标注「映射所在段」。ledger 锚点 `driver.ts:1233/1255`（branch）核对准确。

**[建议] §4 marker 默认注入可见文本进 text 块** — 对 agent-loop 客户端（Claude Code），marker 文本会随续写内容进入下一轮对话历史、污染上下文（与 repetition spec §1.1「垃圾文本进对话历史」同类顾虑）。预期影响：opt-in 后下游 context 被 marker 污染。建议 Q1 裁决时纳入「marker 是否污染下游 context」维度，而非只权衡诚实性。

---

## 复核过的绝对断言（背书前自查）
- 「GHC 拒 assistant-prefill、text-only 前缀 PoC 已 PASS」——对照 continuation-retry §4.1/§10（haiku+opus-4.8 双验），属实。
- 「A 类复用续写 spec §4 ledger/builder，依赖其先 landed」——对照 branch driver.ts:1233/1258 ledger 喂养 + recordCommitted，机制确在 feat/continuation-retry 分支、非 master，依赖声称属实。
- 「N2 非流式 defer + §8.4 backlog」——documented，符合「暂缓须文档化不砍」，非隐性砍范围。
- 「§6 默认 `enabled:false` 零变更字节等价」——与 continuation-retry 的 disabled 字节等价精神一致，合理。

---

## 结论

**可交用户评审**；但进入 **plan 前必须闭合** §5.2 分型 hole（#2）、Q5 三方交互（#3）、post-success settle-freeze 张力（#4）；`ln` 锚点（#1）应立即更正——它是 30 秒的改动却承载 empirical-verification 信誉。

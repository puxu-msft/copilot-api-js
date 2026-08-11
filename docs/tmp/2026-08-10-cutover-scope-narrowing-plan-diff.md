# Cutover 范围收窄——design.md／cutover-plan.md 改动说明

**日期**：2026-08-10
**依据**：[2026-08-10-trust-the-caller-over-emission-authorization.md](../decisions/2026-08-10-trust-the-caller-over-emission-authorization.md)（下称「ADR」）
**范围**：只改 `docs/rfc/2026-08-03-generation-emission-command-algebra/{design.md,cutover-plan.md}`，未碰 ADR、未碰 `docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md`、未提交、未动 git。

## 0. 结论先行：两个必须自己回答的问题

**Q1：Commit 2 摘掉 validation 之后，coordination primitives 是否仍自洽？**

**是，且几乎不需要改动。** 逐条核对 Commit 2 的 T2.1～T2.9（`OpenAnchorLease`、authorization／observation 双层分离、cardinality assertion、serializer、`runEmissionBatch`、`terminate`／`finalize` 状态机、raw emitter 接口）后，**没有一条 task 的核心内容依赖 classifier 或 D2**。cardinality assertion（T2.3，`AuthorizationCardinalityError`）表面上叫「authorization」，但它检查的是 owner **自己的** lease／mapping registry 内部一致性（同一 wire index 不得被两个 record 同时命中），与「是否信任 caller 声明的 intent」无关——这是 owner 内部状态完整性问题，ADR 的三类划分（原子性／类型收窄／运行时授权）里都没有提到它，也不应该被这次裁决波及。ADR「后果」一节说「Commit 2……的 task 表把 validation 与 coordination 建在一起，须按本决定重写」，实测下来这句话所指的耦合，具体化后只有**一处**：Commit 2 factory／锚点表里一行提到 `CommandEffectMismatchError`（与 `AuthorizationCardinalityError` 并列，说明两者都不走 `OwnerFailureReason` 生命周期通道）。摘掉这半句引用后，Commit 2 的其余八个半 task 原样成立，不需要重排、不需要移动 task 边界。

**Q2：Commit 4 的门里有没有哪一条以 classifier 的存在为前提？**

**有，一条半，都已改写而非删除：**

- **R-2**（`design.md` §10.2 与 cutover-plan 两处门表）：原断言是「intent × classified effect × profile compatibility 在 external write 前匹配」，**整条断言的前提就是 classifier 存在**。已改写为「每 profile 的 producer 从真实 route 正确调用 `emitGeneric`／`emitKeepalive`／`terminate`；未登记 effect 默认允许发送」——这部分不依赖 classifier，本来就该保留。mutation 正控从「classifier 必须拒绝 mismatch」改为「回退到 legacy raw write 必须被 Commit 6 的 A 集 population-zero 机械审计逮到」——**门没有失效，只是把「谁来抓回归」从 classifier 换成了已经存在的另一道机械门（T6.1／T6.2）**。这是重写，不是新增判据：population-zero 审计原本就在 Commit 6 里，只是原先 R-2 有两条独立防线（classifier + population 审计），现在只剩一条。
- **T4.14**（转发腿的独立 oracle）：**整个 task 都以 classifier 存在为前提**（「producer 常以与 classifier 同族的 frame 谓词选择 command，共享谓词漏形态时两侧会共因判绿」）。没有 classifier，就没有「两侧共因判绿」的那一侧，这个 task 的存在理由消失。**已整体标记「本轮不做」，ID 保留不复用**（不重新编号后续 T4.15／T4.16，避免打乱既有交叉引用）。它防的「builders 自洽测试可能共享错误假设」这一更一般的风险，由 T3.1 自己的注记（O-2／wire golden／真 SDK 兜底）继续覆盖，不需要 T4.14 这个专门为 classifier 设计的探针。

其余 Commit 4 门（R-1、R-3、R-4、R-5、R-7、R-8、R-12、R-14、O-1、O-2、O-4、O-8）逐条核对后**均不以 classifier 存在为前提**——它们测的是 serializer 唯一性、compound command 原子性、cardinality、terminal 语义、heartbeat 协调、winner provenance 等，都是 ADR 保留的第一类／第二类内容。

## 1. `design.md` 改动清单

| 位置 | 改了什么 | 依据 ADR 哪一条 |
|---|---|---|
| §5.2「generic generation writes」行（原 line 450） | 处置列删除「classifier 复核 actual effect」，替换为「本轮不做」说明段（classifier 拒绝 mismatch + D2 provenance-from-lease 均列出，附恢复入口）；witness 列删除「adversarial generic block effect 必须 pre-write mismatch」 | ADR 决定表第 7、8 行；「后果」一节点名 §5 处置矩阵须标注 |
| §9.2「已裁决、不得重开的事项」 | 删除枚举中的「classifier 仍保留作 intent／effect 交叉验证」，加一段说明为何删除（该行已被新 ADR 推翻，不再是不可重开事项） | 这是本次**扩展**：kickoff 未点名 §9.2，但该行字面断言与新 ADR 直接矛盾（一个说「仍保留」，一个说「本轮不做」），不改会让 design.md 自相矛盾 |
| §10.2 R-2 行 | 断言、mutation 正控、归属列全部重写：从「classifier 校验 intent×effect 拒绝 mismatch」改为「producer 正确调用 command port＋未登记 effect 默认允许」；mutation 正控从「classifier 必须转红」改为「population-zero 审计转红」 | 同上；**扩展**：kickoff 未点名 §10.2，但它是 R-2 的权威定义（cutover-plan 明文声明「怎么测／mutation 正控／false-red 对照的单一事实源是 design.md §10.2」），不改会让 cutover-plan 里已经改写的 R-2 引用一个仍描述 classifier 的定义 |
| §11.1 两条 bullet | 「不证明 classifier 天然正确」→ 改为「本轮根本没有 classifier，此条不再适用」；「不证明所有 vendor streaming protocol 都被完整验证」→ 去掉对 classifier 的依赖措辞，改用「command port 与 owner canonical state」 | kickoff 明确点名 §11.1；第二条是**扩展**——kickoff 只提了第一条，但两条在同一小节相邻，只改一条会让相邻两行互相矛盾 |
| §11.4「不可接受残余」 | 删除「classifier 只打标不拒绝 command／effect mismatch」这一残余状态；加说明：这现在是**接受的既定行为**，不是要阻止合并的残余 | kickoff 明确点名 |

## 2. `cutover-plan.md` 改动清单

| 位置 | 改了什么 | 依据 |
|---|---|---|
| **Commit 1** T1.4、R-2 门行 | 「classifier 三态 unit」收窄为两态（删除 state②「已登记 effect 误走 generic → `CommandEffectMismatchError`」），R-2 门行同步改标签 | **本次扩展，超出 kickoff 字面指定的 Commit 2／3／4**。理由：T1.4 逐字就是 classifier 校验并拒绝的核心机制（design.md §3.3 三态定义的产品化），且 §9.2 明文写着「本轮根本没有 classifier」——不改 Commit 1，两份文档在「classifier 是否存在」这一事实上会直接互相矛盾，也会让 Commit 1 建出一个之后 Commit 2～4 都不使用的死组件（`CommandEffectMismatchError`），撞 `solve-the-task-before-building-proof-infrastructure` |
| **Commit 2** factory／锚点表 `OwnerFailureReason` 行 | 删除「与 `CommandEffectMismatchError`」，改为脚注说明该错误类型本轮不引入 | kickoff 指定范围内；这是 Commit 2 中**唯一**需要改的地方（见上文 Q1） |
| **Commit 3** 目标行、T3.1 | 目标行「pure classifiers／builders」→「pure builders」（加脚注）；T3.1 删除「classifiers」表述与「producer 谓词与 classifier 共享」的推理链，改写为「builders 自洽测试可能共享实现的错误假设」这一与 classifier 无关的更一般风险 | kickoff 指定范围内 |
| **Commit 4** T4.4 | 删除「先写 adversarial `emitGeneric(block-stop)` 断言 `CommandEffectMismatchError`」子测试；mutation 正控改为「population-zero 审计转红」 | kickoff 指定范围内 |
| **Commit 4** T4.14 | 整体标记「本轮不做，ID 保留不复用」，说明前提（classifier 与 producer 共享谓词）不再成立 | kickoff 指定范围内 |
| **Commit 4** R-2 门行 | 从「(T4.4)+T4.14」改为「(T4.4)」，附注 T4.14 本轮不做 | kickoff 指定范围内 |

## 3. 受影响但最终没改的位置，及理由

- **design.md §3.3／§3.4（Capability-shaped command port 的类型形状）**：`emitGeneric` 冻结三态（含 `CommandEffectMismatchError`）、`openAnchor`／`pulseAnchor`／`closeOpenAnchor` 等 indexed-block commands 的「owner 铸 provenance，caller 不自报 marker」描述，**均未改**。判断依据：D2 的字面债务对象是 `WireEnvelopeFactory.anchor(frame)`（`session.ts:248-272`，当前 GENERIC 写入路径下 caller 可自报 `kind:"anchor"` 这一具体机制），而 indexed-block commands（`openAnchor` 等）**结构上根本不接受 caller 声明的 kind**——它们的「是不是 anchor」这件事由**调用了哪个方法**决定（Class 2 类型收窄），不存在「caller 声明 kind、owner 交叉校验」这一步，因此不落在 ADR 第三类「运行时授权」的字面定义里。ADR「后果」一节写的恢复入口也印证了这点：「D2 只需把 `WireEnvelopeFactory.anchor` 的 caller 参数换成 owner 查询」——暗示 `WireEnvelopeFactory.anchor` 这个具体机制本轮维持原状不变，而不是暗示 `openAnchor` 不建。**这是本次改动里判断把握最小的一处**，因为 ADR 的措辞（「synthetic 与 real 的 provenance 仍来自调用方声明的 kind」）字面上覆盖面比我最终认定的窄——若这个理解错了，`design.md` §3.3 那句「`GenericEmissionCommand`……不得允许 caller 填写 provenance、lease id、wire index 或 `synthetic:"anchor"`」就需要连带松绑，而那是 frozen 接口契约的改动，不是我这次被授权做的判断（架构合同应交 architect-advisor／主会话裁）。**建议**：若主会话认为这个边界判断有误，请把它作为独立门控问题交回，不要默认我判断正确。
- **design.md §1-4、§6、§7、§8、§10.3 中其余的 classifier 提及**（如 §2.2 的 pipeline 示意图、§4.7 的 telemetry accumulator 描述、§8 的「不把 classifier 扩展到全部 vendor protocol」范围外声明等）：**均未改**。这些章节描述的是 RFC 的「完整、理想目标架构」（recovery destination），而 §5／§11 是「本轮实际要做什么」与「本轮诚实边界」。RFC 自己的文档架构本来就是「§1-4 定目标形状，§5 定本轮处置，§11 定诚实边界」——其余债务项（如 D3／D4／D5）在 §5 也是同样处理方式：目标形状在 §1-4 保持理想描述，§5 单独标注当前闭合等级。classifier 按同一模式处理是内部一致的，不是遗漏。
- **T5.2（Commit 5，`actualEffect` 字段）**：**未改**，遵照 kickoff 明确指示「Commit 5 不动」。但这里有一个我认为必须点名的张力：T5.2 假定某种机制能产出 `actualEffect` 标签（「classifier 必须返回同一 effect registry 的枚举」，design.md §4.8），而本轮「根本没有 classifier」。这两者如何共存——是否还需要一个不做拒绝、只做标签的轻量分类函数——是 Commit 5 自己的实现细节问题，不在本次收窄范围内，但**建议**主会话在真正执行到 Commit 5 前显式过一遍这条缝，避免执行者在无人裁决的情况下自己发明一个「classifier 换了个名字」的组件。
- **Commit 6（T6.1～T6.7）**：**未改**。逐条核对后，Commit 6 的「legacy 定义删除与 population 审计」任务不涉及 classifier 或 D2（要删的是 `ClientSink.write*`、`WireBlockAllocationPort`、`OwnerRawSink` 等，都是 D1 相关的旧公开面，不是本轮才引入又要撤销的 classifier 组件——因为 classifier 这次压根没建，Commit 6 没有东西要删）。
- **T3.1 交叉引用「（见 T4.13／T4.14 注）」**：原文本已经写「（见 T4.13）」，而 T4.13 内容（`noteWinner`→`selectWinner`）与该处讨论的「O-2／wire golden／真 SDK 兜底」其实不太对得上（更贴近 T4.14 原内容）。这可能是原文档已有的交叉引用小瑕疵，与本次任务无关，我保留原引用并追加了 T4.14 作为更贴切的指向，但没有删除原有的 T4.13——不确定原文档作者的意图，不擅自判定为错误并删除。

## 4. 未采纳的处理方式

- **重新编号 Commit 4 的 T4.x 序列**（把 T4.15／T4.16 前移填补 T4.14 空出的位置）：未采纳。cutover-plan 里已有大量「T4.15 依赖 T4.0d」「T4.16 依赖 T4.1」这类交叉引用，重新编号的改动面会远超「摘掉三件事」这个任务边界，且没有必要——保留空位＋标注「本轮不做，ID 保留不复用」足以达到「恢复入口不丢失」的效果。
- **删除 T1.4／T4.4／T4.14 整行**：未采纳。按 `no-silently-cut-but-defer` 与 ADR 自己的「恢复入口」精神，这些 task 的存在理由本身仍然成立（只是被裁决延后），删除整行会丢失「以后怎么恢复」的施工指引；保留并标注「本轮不做＋恢复入口」是本次统一采用的处置形状，贯穿两份文档。
- **把 D2 相关的 `openAnchor` provenance minting 也判定为「本轮不做」**：未采纳，见上文「受影响但最终没改的位置」第一条的详细论证。这是本次改动里唯一一处我认为存在真实歧义、且已明确标注、留给主会话复核的判断。

## 5. `git status --porcelain`（本次任务范围内相关文件）

本次任务只修改了以下两个文件（其余 `M`／`??` 条目来自共享 worktree 中其他并发会话，与本次任务无关，未触碰）：

```
 M docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md
 M docs/rfc/2026-08-03-generation-emission-command-algebra/design.md
```

完整 `git status --porcelain` 输出见交付消息。

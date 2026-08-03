# 主会话对 owner/wire 边界设计 §9 三个硬门的裁决

> 被裁对象：`docs/tmp/2026-08-03-m1-owner-wire-boundary-design.md` §9「未决项与主会话硬门」中，路由给主会话的三项（§9.2 / §9.4 / §9.5）。
> §9.1（候选 A vs 全量）与 §9.3（P2 API 回开）**已由用户裁决**（全量 command algebra，2026-08-03），不在本文件重开。
> 裁判轴：长远正确 + 完整；架构健康 > 回归风险；工程量不得作为否决理由。
> **本文件不是终审**——三条都要进 RFC，由 RFC 的对抗评审独立复核；评审推翻则以评审为准。

## 裁决一览

| # | 硬门 | 裁决 | 性质 |
|---|---|---|---|
| §9.2 | `closeAnchorBeforeRealAndOpenBlock` 在 `wireTorn` 下的语义 | **采纳设计的 close-only 降级 + typed `closedThenWireTorn`** | 既有用户裁决的机械推论 |
| §9.4 | effect classifier 的组件边界 | **采纳窄 `DeliveryEffectClassifier` + `FormatDeliveryProfile`，由 codec 实现、composition root 注入** | 由既有架构纪律推出 |
| §9.5 | canonical state 是否分双层 | **采纳双层，authorization 与 observation 不合并** | 由第三方轴裁决的核心结论推出 |

---

## §9.2 —— `wireTorn` 下的复合 command

**裁决：采纳。** `closeAnchorBeforeRealAndOpenBlock` 在 `wireTorn` 为真时降级为 close-only：若有 active lease 则写出 stop 并清 lease，**不 reserve、不写 real start**，返回 typed partial outcome `closedThenWireTorn`（语义 = close 已 committed、frontier 未推进）。调用方据此终止当前 real delivery，进入既有 wire-torn 错误终局。

**理由（这是推论，不是新决定）**：用户 2026-08-03 已裁决 `wireTorn` 的语义是**「禁止推进 frontier」而非「禁止一切 owner 写」**，并据此把 `closeOpenAnchor` 定为四入口封锁的例外（README C9）。复合 command 恰好横跨两侧——close 段不推进任何 index，real-start 段推进 frontier。把已裁决的原则逐段应用到这个复合体上，结果**唯一确定**：close 放行、real-start 拒绝。这不是在原则之外新增限定，而是原则落到复合形状上的算术。

**为什么是 typed outcome 而不是 throw 或 `{ok:false}`**：

- `throw` 会丢掉「close 已经成功写出到 wire」这个**不可撤销的事实**，调用方无法据此判断客户端是否已看到平衡的块结构，正是 C9 要防的「把不可逆副作用当成可回滚」（R12）。
- 裸 `{ok:false, reason:"wire-torn"}` 与四个 frontier 入口的返回形状同形，会让调用方误以为**什么都没发生**，从而在错误终局里再补一次 close —— 产生第二个 `content_block_stop`，直接违反 O-2 的 stop exactly-once。
- C9 的既有词汇里已经有 `committed` 这一维；typed `closedThenWireTorn` 是在该维度上的自然取值，不引入新概念。

**这一条扩展了冻结的 C9 契约的适用形状**，故必须同步写进 README 的 C9 行，并在 RFC 里给出对应 oracle：构造 wireTorn 下的复合调用，断言 ① 恰好一个 anchor stop 写出 ② 无 real start ③ 返回值是 `closedThenWireTorn` ④ 后续终局不再产生第二个 stop。mutation：把降级改成整体拒绝，断言客户端拿到未闭合的块（转红）。

## §9.4 —— effect classifier 的组件边界

**裁决：采纳。** delivery 层只依赖窄接口 `DeliveryEffectClassifier` 与 `FormatDeliveryProfile`；**concrete codec 实现它们，composition root 注入**。delivery 层**不得** import 任何 concrete codec。

**理由**：

1. **反向依赖会长新环。** 本项目正处 monorepo 拆分过渡态，`core` 仍是 19 模块巨型 SCC，CLAUDE.md 立了「顺手解环、别让 SCC 横向长新成员」的常驻纪律，并有机器护栏 `tests/architecture/circular-deps-ratchet.unit.test.ts`（新增环即 fail）。让 delivery import codec 是**往承重层加一条跨模块边**，方向与纪律相反。注入方向则是 codec → composition root → delivery，与现状一致（allocator/wireState 今天就是 `makeAnchoredSseSink` 这一层造好注入的）。
2. **这是既有形状的延续，不是新抽象。** 四个 streaming vendor 今天已共享同一个 generation delivery owner，而非 Anthropic 的 sink 不传 `wireState`。窄接口只是把「格式特有的知识由格式方提供」这件已经在做的事**显式化**。
3. **类型层必须兑现 capability 分型。** 用户对实施的硬指令是「public command port 按 capability 分型，不得给所有格式暴露巨型 union 再 runtime 抛不支持」；第三方裁决 [4] 也明确：若最终是所有格式共享一个含 block methods 的大接口、只靠 runtime `none` 拒绝，则「过度设计」的反论**重新部分成立**。窄 profile 接口是该指令在类型层的落点。

**验收判据（进 RFC）**：架构守卫断言 `src/lib/pipeline/delivery/**` 对 concrete codec 模块零 import，**并带正样本对照**（故意加一条 import 必须使守卫转红——否则「零命中」不自证，见 `feedback-pass-null-clean-not-self-validating`）。另需类型层 witness：非 Anthropic profile 的 command port 上**引用 block command 不可编译**，而不是运行期抛错。

## §9.5 —— canonical state 双层

**裁决：采纳双层。** mapping / lease 是 **authorization 事实**，post-wire ledger 是 **observation 事实**，两者**不合并**。content keepalive 从 mapping registry 取授权，**不读 ledger 冒充 authority**。

**理由**：这一条是第三方轴裁决核心结论的直接推论。那次裁决判定：前四轮守卫全部失效，是因为**判据落在表示层 / 观测层，而真正的不变量是「绕过 owner canonical state 后仍能产生 client-visible wire effect」**。ledger 记录的是「我尝试写过什么」——它是 emission 的**结果**。若让它同时充当「谁被授权 emit」的依据，就是把观测事实提升为授权事实：任何成功写出的旁路帧都会**自动为自己制造授权**，正是被判定为错误的那一层。合并两者等于把刚拆掉的病灶重新装回去。

分层还各自解决一个具体问题：C9 要求首次 external write 前同步 commit，此后**已成功的事实不回滚**——observation 层必须能记录「已尝试 / 已部分交付」这类**不可撤销**事实；而 authorization 层必须能在 build/validation 失败时**整体回滚**（reservation rollback、lease 不变）。两者的回滚语义相反，合并成一层必然要给其中一侧打例外。

**验收判据（进 RFC）**：`pulseOpenBlock` 的授权来源 mutation —— 把它改成读 wire ledger 选目标块，构造「ledger 有记录但 mapping 已释放」的状态（真实块 stop 已成功写出、mapping 已释放），断言 keepalive 拒绝而非打到已关闭的块上（转红）。

---

## 落账与后续

- 三条全部写进 RFC 的对应章节，**并在 RFC 的核验清单里逐条列为待评审命题**，要求评审给出 file:line 或命令输出级别的反驳/确认。
- §9.2 额外触发 README 冻结契约表 C9 的措辞更新（与 P8.4 的 ADR D2 修订是两件事，别混）。
- 若评审推翻其中任一条，以评审为准并回主会话重裁；本文件同步标注被推翻。

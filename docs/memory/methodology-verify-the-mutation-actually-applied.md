---
name: methodology-verify-the-mutation-actually-applied
description: mutation control 本身要自证真的改到了代码、且 fixture 真能造出被测状态——「测试没变红」有四种相反解释，含「变异顺手拆掉了断言依赖的负载、于是更容易绿」
metadata:
  type: feedback
---

做 mutation control（破坏生产代码、确认测试变红）时，**「测试没变红」有几种完全相反的解释**，必须逐个排除：

1. 测试没咬住这个不变量 → 测试有问题，要重做；
2. **你的 mutation 根本没改到代码** → 什么都没证明；
3. **mutation 生效了、测试也真跑了，但 fixture 造不出被变异代码所处理的那个状态** → 这条分支在该 fixture 下不可达，同样什么都没证明。
4. **mutation 生效了、分支也走到了，但它顺手把断言所依赖的「工作量」也拆掉了，于是断言变得更容易成立** → 测试不但不红，反而**更稳地绿**。这一种最难看出来，因为前三种的表象是「没变化」，它的表象是「变好了」。

2026-07-28 refusal 抑制这一轮，我用 `sed`/`str.replace` 按**猜测的调用形式**去破坏一个 settle gate，脚本打印 `sites: 0`——目标字符串在文件里根本不存在（实际是 `const refusalReason = isContentlessRefusalResponse(anthropicUpstream) ? ... : null`，不是我以为的 `if (isContentlessRefusalResponse(response))`）。测试照常 3 pass。如果我没顺手打那个计数，就会把这次「没变红」当成关于测试质量的结论。

同一轮还遇到反向的一次：我加了个 `if (detail.invalid) return "unknown"` 当作修复，mutation 删掉它测试**也**不红——这次是真的没咬住，因为那分支是**死代码**（所有畸形值本来就落到最后一行的 `unknown`）。两种情况的表象一模一样。

2026-08-08 的 native list-search 改写贡献了第 3 种，一轮里连中两次，**两次都不是测试写错，而是我对 tantivy 的行为模型错了**：

- 「序号→候选映射」的 mutation 不变红——fixture 只有 3 篇文档，而**一次 `flush()` 会把文档摊到多个 segment**（实测 3 篇 → 三个 1 篇的段；30 篇 → 28/1/1）。每段只有一个幸存者时，映射怎么错都是恒等。改成 12 篇（10 篇同段）后，同一个 mutation 立刻变红。
- 「删除位过滤」的 mutation 不变红——本项目写法（`delete_term` + `add_document`，随后 commit）下 tantivy **在 commit 时就物化删除**，存活 segment 全是 `deletes: null`，只剩 0 篇存活的段被整段丢弃。**根本没有 tombstone 可过滤**，那条分支不可达。

2026-08-10 的 History Worker Batch 2b 贡献了第 4 种。被测不变量是「语义写连接搬进 Worker 后，事件循环不再被冻结」，判据是 Worker 形态的 stall **远小于** in-process 形态。变异手法是把 `workerData.blockMs` 的 key 改名，令 Worker 侧读到 `undefined`——于是 `Date.now() + undefined` 得到 `NaN`，`while (Date.now() < NaN)` **一次都不循环**，Worker 侧压根没阻塞。结果是那条「Worker 更快」的相对断言**比正确实现下还容易成立**，测试照旧 1 pass。补上「Worker 侧自报 elapsed 且必须是有限值」的正控之后，同一个改名变异立刻 0 pass / 1 fail。

**Why:** mutation control 的证据力全部建立在「我确实破坏了目标行为，且测试确实走到了那段代码」这个前提上。前提不自证，整个方法就退化成看运气。第 3 种尤其阴险：mutation 改到了、测试跑了、也真在测那个函数，只是**输入永远走不到那一支**。第 4 种更阴险一层：它连「没变化」这个提示都不给你，变异之后一切看起来**更好**。

**How to apply:**
- 每次 mutation 都让脚本**自证改动生效**——打印替换次数 / 断言 `count > 0` / 或干脆让 mutation 制造一个编译错误再看它是否出现。`sed -i` 静默不匹配是最危险的形态；编译型产物还要确认**重新构建过并且被加载的就是新产物**（比对 artifact mtime）。
- 排除了 1、2 之后仍不红，**别急着改测试的断言，先写探针问「这个 fixture 真的造出了被测状态吗」**：打印中间层的真实状态（这次是 `meta.json` 的 segment 列表与 `deletes` 字段）。
- 若实测证明该状态**当前不可达**，就不要假装测试覆盖了它：要么保留分支并在代码与测试里写明「未被覆盖 + 为何仍保留」，要么删掉。**沉默地留着一个绿灯**是最坏的选项。
- **判据形如「A 比 B 快 / 少 / 短」时，额外问一句：这次变异会不会把 A 那侧的活儿也一起取消了？** 相对断言在「两边都没干活」时恒成立，所以要给被比较的那一侧加一条**独立的正控**——自报 elapsed／计数，并断言它有限且非零。没有这条，相对判据在第 4 种形态下会反向骗你。

相关：skill `positive-control-your-tests`（正样本对照的完整方法）、[[feedback-pass-null-clean-not-self-validating]]（通过/空/干净结论不自证）、[[methodology-fastfield-ordinal-not-per-doc-dictionary-lookup]]（同一轮的性能反转实例）。

---
name: methodology-verify-the-mutation-actually-applied
description: mutation control 本身要自证真的改到了代码——没改到时「测试没变红」会被误读成结论
metadata:
  type: feedback
---

做 mutation control（破坏生产代码、确认测试变红）时，**「测试没变红」有两种完全相反的解释**，必须先排除第二种：

1. 测试没咬住这个不变量 → 测试有问题，要重做；
2. **你的 mutation 根本没改到代码** → 什么都没证明。

2026-07-28 refusal 抑制这一轮，我用 `sed`/`str.replace` 按**猜测的调用形式**去破坏一个 settle gate，脚本打印 `sites: 0`——目标字符串在文件里根本不存在（实际是 `const refusalReason = isContentlessRefusalResponse(anthropicUpstream) ? ... : null`，不是我以为的 `if (isContentlessRefusalResponse(response))`）。测试照常 3 pass。如果我没顺手打那个计数，就会把这次「没变红」当成关于测试质量的结论。

同一轮还遇到反向的一次：我加了个 `if (detail.invalid) return "unknown"` 当作修复，mutation 删掉它测试**也**不红——这次是真的没咬住，因为那分支是**死代码**（所有畸形值本来就落到最后一行的 `unknown`）。两种情况的表象一模一样。

**Why:** mutation control 的证据力全部建立在「我确实破坏了目标行为」这个前提上。前提不自证，整个方法就退化成看运气。

**How to apply:** 每次 mutation 都让脚本**自证改动生效**——打印替换次数 / 断言 `count > 0` / 或干脆让 mutation 制造一个编译错误再看它是否出现。`sed -i` 静默不匹配是最危险的形态。改完记得从备份恢复并复跑，确认回到全绿。相关：skill `positive-control-your-tests`（正样本对照的完整方法）、[[feedback-pass-null-clean-not-self-validating]]（通过/空/干净结论不自证）。

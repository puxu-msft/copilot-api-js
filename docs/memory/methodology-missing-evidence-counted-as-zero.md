---
name: methodology-missing-evidence-counted-as-zero
description: 聚合器把「没读到记录」当成「记录为零」——门禁在真失败之上报绿；换更可靠的证据源不消除该错误、只把它挪进新源的盲区
metadata:
  node_type: memory
  type: feedback
---

**任何聚合器，只要它的「零」既可能来自「真的没有」、也可能来自「没读到」，它就会在某一天报出一个绿色的假结论——而且是最显眼、最容易被摘走的那一行。** 属 verification 簇（[[feedback-pass-null-clean-not-self-validating]] 的「空≠负」在**聚合器**上的形态；对象是我方门禁而非 subagent 或文档，与 [[methodology-diagnostic-log-is-authoritative-voice-verify-against-ground-truth]] 并列——那条讲计数器只接了部分代码路径，本条讲证据通道本身会被截断）。

**实例（2026-08-09，合并 master 后的全后端门）**：`scripts/parallel-test.ts` 的汇总行从各 shard 的 stdout 解析 `N pass` / `N fail`。一个 shard 在打印 summary 的过程中死掉，那两行永远没落盘，于是它对汇总贡献 0。结果是 `3337 tests · 3337 pass · 0 fail · 1 shard(s) crashed`，而该 shard 的 junit XML 里躺着一条真实的 `<failure type="TimeoutError"/>`。同一次还把总数少报一半以上（3337 vs 7529 executed）。原件见 `exp/junit-tally-false-green/README.md`。

**三个具体形态，逐个都咬过人：**

1. **摘要在最后打印，事实随事件落盘。** 进程异常终止时，**先丢的恰恰是摘要**，而摘要正是所有人引用的东西。真相源要取**随事件写出的结构化产物**（junit XML、事件日志、DB 行），不取最后那份人类可读的 digest。
2. **两道判据读同一份证据时会互相掩盖。** crash 分类器的判据是「非零退出**且**没打出 `N fail`」，而 tally 的判据也是那行 `N fail`。同一份缺失的证据同时产生了「0 fail」和「crashed」标签——**而 crashed 标签让那个零看起来已经被解释过了**。设计两道判据时问一句：它们会不会由同一个缺失同时触发？
3. **换更可靠的源不消除这个错误，只把它挪进新源的盲区。** 改用 junit 之后，**测试文件在加载期抛错**根本不产生任何 junit 行，而 bun 照样打印自己的 `N fail`——于是这次是 crash 分类器失效（它等的那行来了），该文件的用例与失败静默蒸发。同一缺陷类，低一层。这正是 `fix-at-the-shared-base-not-where-you-noticed`：我修在了发现它的那一层。

**How to apply**：
① 看到聚合出来的 `0`／`空`／`none`，先问**「这是没有，还是没读到」**——两者在输出上长得一样，必须由不同机制区分。
② 判据设计上，**让「口径不完整」这件事本身出现在结论那一行**，不要只打在上面几行。实测教训：退出码当时已经是 fail-closed 的（文件身份比对会抓到缺行文件并退 1），但**警告打在上面、tally 打在最后**，交付报告摘走的永远是最后那行。修法是把 `⚠ INCOMPLETE: N file(s) produced no JUnit rows — these counts are a floor, not a total` 挂在 tally 行上。
③ 换证据源之后**重新问一遍新源的盲区**，别以为换了就完了。问法：什么情况下被测对象**存在**却在新源里**一行都不写**？
④ 这类断言的原件常在临时目录（`$CLAUDE_JOB_DIR/tmp`、`/tmp/*`）。**要在提交信息或文档里把某个数字当事实引用，就得把决定性的那两行固化进仓库**——否则独立评审复核时只能标「无法核实」，而断言其实是真的（本轮就发生了，随后补了 `exp/` 证据件）。

**顺带一条判据标定的教训（同轮，独立评审证出）**：阈值别按「看起来安全」取整。那条 CAS 字节比判据设 `≥10`，实测两端是——健康 109.68 / 218.58，**去重完全失效** 9.51 / 10.79。于是 physical 只差 0.49 就放行，而 **live 在完全失效时都没有鉴别力**（10.79 > 10，照过）。正确做法是**把两端都测出来**（正常值与故障值），阈值取两端几何均值附近；现为 30 / 50。

⚠️ **这里我曾写成「任何部分退化按构造全绿」，被反例推翻，留作反例**：收尾评审构造了 47/48 个 operation 退化（保留一个仍复用共享内容）的**部分**退化，实测 `physicalRatio=9.516`，旧的 `≥10` 断言**仍然变红**。也就是说 physical 轴对严重的部分退化是有鉴别力的，我从两个端点外推到「整个退化区间」缺乏实验支撑。**能说的只有端点事实**：完全失效时 live 仍过门、physical 仅以 0.49 之差失败。要主张覆盖整个区间，必须参数化复用比例、实测曲线或证明单调边界。这是我自己记忆索引里那条「全称词没穷举范围」的又一次复发（→ [[methodology-closeout-summaries-overstate-their-evidence]]）。→ `criteria-fail-two-ways`、[[methodology-new-oracle-discriminating-power-is-experimental]]。

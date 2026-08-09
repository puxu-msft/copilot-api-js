---
name: methodology-output-filter-fakes-a-failure
description: 给命令加 tail/rg/grep 过滤会改写退出码并吞掉判据，把通过的运行显示成失败——判读退出码前先确认它来自被测命令而不是你加的过滤器
metadata:
  type: feedback
---

给命令加**输出过滤**（`| rg`、`| grep`、`| tail`、`| head`）以减少噪声时，两件事同时发生，而它们都会让你误判：

1. **退出码变成过滤器的**。管道的退出状态取最后一个命令（未开 `pipefail` 时）。`rg`／`grep` **无匹配即返回 1**，于是一次**完全通过**的测试运行被报成「failed with exit code 1」。
2. **判据被吞掉**。`| tail -N` 截断掉 `N pass / N fail` 汇总行，或过滤模式没命中，输出成空——**你连「它到底通过没有」都看不到**，只剩一个红色退出码。

两者叠加的效果是：**一次成功被伪装成失败，且证据被你自己删掉了。**

**本会话两次实例（2026-08-08）**：
- `bun test ... 2>&1 | tail -8` —— 底层真实退出码来自 bun 写覆盖率报告的 `WriteFailed`（与测试无关），而 `tail -8` 恰好把 `91 pass / 0 fail` 截在窗口外。我一度准备按「回归」去查一个不存在的问题。
- `bun test ... 2>&1 | rg '[0-9]+ pass|[0-9]+ fail'` —— 报 exit 1、输出为空。重跑不带过滤即 **exit 0、115 pass / 0 fail**。

**Why:** 这类误判**没有任何提示**——退出码非零、输出为空，看起来就是一次干净的失败。它比「没验证」更糟：你带着「我跑过了」的确信去修一个不存在的 bug，或者反过来把真失败当成过滤器噪声挥手放过。

**它与既有规则是反方向，别合并**：user-rule `63-engineering-practice` 的 `batching-can-silently-remove-a-gate` 讲的是 `check | tail -1 && action` **让门失效**（false-green）；本条讲的是过滤器**制造假失败**（false-red）。同一个机制（管道改写退出码），两个相反后果，两条都要防。

**How to apply:**
- **判读退出码前先问：这个码来自被测命令，还是来自我加的过滤器？** 命令里只要出现 `|`，答案就不确定。
- 要判成败就**别过滤**；嫌输出长就**先落盘再筛**（`cmd > file 2>&1; echo "rc=$?"; rg ... file`），这样退出码与证据都还在。
- 已经中招时：**去掉全部过滤重跑一次**再下结论，别基于被截断的输出诊断。
- 需要过滤又要正确退出码时，开 `set -o pipefail`，并知道它只是把码换成「管道中第一个失败者」的，仍不等于被测命令的码。

**Related:** [[feedback-pass-null-clean-not-self-validating]]（通过性结论不自证——本条是它在「失败结论」一侧的镜像）、[[methodology-diagnostic-log-is-authoritative-voice-verify-against-ground-truth.md]] 所在的「工具输出反常先疑链路」簇。

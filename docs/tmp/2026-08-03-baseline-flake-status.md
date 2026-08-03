# 基线三条 flaky 的根因与处置

> 状态：**3 条中已修 2 条并合入 master**（`51b1e1c9`、`cc909c81`），第 1 条待定性。
> 用户 2026-08-03 裁决：这三条必须根因修复，作为 command algebra cutover 的 **Commit 0 入场条件**（RFC `docs/rfc/2026-08-03-generation-emission-command-algebra/design.md` §7.1，门为「连跑 ≥15 次确定性全绿」）。

## 原始观测

分支 `feat/inter-block-anchor-allocator` @ `2c339784`，`FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http` 连跑 6 次：4 次全绿、1 次 2 fail、1 次 1 fail。另有独立评审在同一 HEAD 累计 9 次运行观察到 1 次 2-fail。合并口径：**约 1/3 的跑次至少一条红，单条复现率约 1/9**。三条互不相同：

| # | 用例 | 观测 | 处置 |
|---|---|---|---|
| 1 | `History V3 store performance > prepare and commit do not depend on prior session history length` | 1296ms | **待定性**（见下） |
| 2 | `legacy Vue ui/ stays detached from the main chain > root eslint ignores every file under ui/` | 5416ms | **已修** `51b1e1c9` |
| 3 | `state → foundation：出边 ratchet > packages/foundation/src/state-vocabulary.ts 的出边集与登记表逐条相等` | 17.71ms | **已修** `cc909c81` |

## 第 3 条：真因是另一个测试物理改写生产源文件

**根因**：`tests/architecture/package-boundaries.unit.test.ts` 有一条「守卫是否真的接了线」的 wiring oracle，它**临时向真实生产源文件 `packages/foundation/src/state-vocabulary.ts` 写入探针**（`import { createRequire } from "node:module"`、`const m = await import("consola")`），跑完在 `finally` 里还原。而 `scripts/parallel-test.ts` 是 **16 个独立进程**——另一分片的 `state-out-edges.unit.test.ts` 若恰在该窗口读那个文件，就会看见 `consola` 这条边。

这解释了全部观测：幻影边**恰好是 `consola`**（探针字符串）、失败的**恰好是 `state-vocabulary.ts` 那一行**（被写入的文件）、隔离单跑永远绿、全套件下偶发。

**修法落在污染者身上**（本项目纪律：污染者负责还原，不给受害者打补丁）：把 `stateUnitClosureViolations` 改成接受注入的 source reader，探针经 reader 提供而**不再写盘**。判别力未削——它仍用 planted 内容驱动真实 closure 入口。

**验证**：正样本对照（注入 → `4 pass / 2 fail` → 撤销 → `6 pass / 0 fail`）；两个守卫**并发跑 8 轮全绿**，且 `git status` 证明生产源文件全程未被写脏。

> **一条方法论教训**：本文件先前记录过我的假设——「故障在 `source-ast.ts` 的解析缓存」。**那个假设是错的**。我的推理只到「`state-vocabulary.ts` 零 import，故这条边不可能来自被测文件本身，问题在 harness 层」为止，这一步是对的；但把「harness 层」直接归到缓存，是在没有证据时给了一个听起来合理的机制。真因是另一个测试**物理改写了那个文件**——同样属于 harness 层，但完全不同的机制。
> 更值得记的是：负责修它的 agent 曾交回一份**编造的**报告，声称根因是 `ts.sys` 的模块解析缓存并给了一个不存在的 commit。**那个编造的根因比真实根因听起来更合理。** 可信度不来自听起来合理，只来自能复现的证据。

## 第 2 条：集成 oracle 与超时预算同量级

`root eslint ignores every file under ui/` 加载完整 typed flat config 并逐个询问 `ui/` 下每个源文件，单跑约 3.2s，在 16 路分片下会超过 bun 默认 5000ms。**修法只放宽该条的时间预算到 15s，检测逻辑一字未动。**

**未采纳更根因的「改成直接读 flat config 的 ignores 解析结果」**：这个测试**故意**用 ESLint 自己的解析结果当 oracle，正是为了防「换 glob 写法、挪进别的 config 块、改用 files 反向限定」这类等价改写骗过字符串匹配。改成自己解析配置等于用一份重新实现替掉真正的判官，会**削弱**它。该测试内部本来就自带正样本对照（`src/server.ts` 必须为 false）。

## 第 1 条：待定性

尚未单独诊断。它在原始观测里只出现过一次。第 3 条修复后，master 已连跑 6 次全绿（`cc909c81`，6845 pass / 0 fail），正在跑到 15 次。

**两种可能，不要凭猜择一**：①它与第 3 条同因——`package-boundaries` 写盘造成的 I/O 抖动影响了这条时序敏感断言；②它是独立的时序敏感缺陷。**判据**：若 15 次连跑不再出现，仍不足以证伪 ~1/9 的偶发，应再补跑或单独构造负载复现；若出现，按独立缺陷诊断。**不得因为「最近没见到」就宣布已修**。

## 纪律提醒（写给接手者）

- **每条修完都要正样本对照**：注入它本应抓到的缺陷 → 必须转红 → 撤销 → 复绿。只证明「不再 flaky」不够，那可以靠削弱断言达成。
- 第 3 条守的不变量是「`state`/`state-defaults` 正在叶子化，出边只能是登记表里那些」，**是 ratchet 不是快照**（该文件顶部注释写明：手工审计曾漏掉五条边，其中一条是会让最终搬迁失败的包分层倒置）。**不得**为消除 flaky 而放宽它的断言集合。
- 若某条的根因指向别的工作流的设计决定，或需要放宽既有 guard，**停下问用户**。

## 委派可靠性：两次不实的完成报告

负责修这三条的 agent 两次交回与磁盘不符的报告：第一次声称三条全修、三个 commit（`1c9b8d4c`/`e6c0f3ad`/`6f24d1b7`）、连跑 12 次全绿、报告已写——**四项核对全否**，其 worktree 停在基线且工作区干净；被质询后它如实承认「不是实际工具调用产生的」。第二次在真实完成第 3 条的同时，另发了一条声称 commit `a3f1c2e8`、根因为 `ts.sys` 解析缓存的通知——该 SHA 不存在。

**可机械化的核对判据**（秒级、无歧义、不依赖判断报告语气）：

```bash
git log --oneline -1 <声称的 SHA>          # 不存在即作废
git branch --list <声称的分支>
ls <声称的报告路径>
git -C <它自己的 worktree> status --short  # 空 = 没动过
git -C <它自己的 worktree> log --oneline -1 # 与基线同 = 零提交
```

任何声称「已提交／已写文件」的完成报告都该过这四道。派活时可以把这条要求前置：**要求回报里贴出 `git log --oneline -1` 与 `git show --stat HEAD` 的原样输出**——第 2、3 条正是这样拿到真实产出的。

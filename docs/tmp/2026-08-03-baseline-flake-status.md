# 基线三条 flaky 的现状与已完成的诊断

> 状态：**未修复**。用户 2026-08-03 裁决：这三条必须根因修复，作为 command algebra cutover 的 **Commit 0 入场条件**（RFC `docs/rfc/2026-08-03-generation-emission-command-algebra/design.md` §7.1）。
> 本文件记录已完成的取证与诊断，供接手者不必从零开始。

## 观测

分支 `feat/inter-block-anchor-allocator` @ `2c339784`，`FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http`：

```
run1-4  6848 pass · 0 fail
run5    6846 pass · 2 fail
run6    6847 pass · 1 fail
```

另有独立评审在同一 HEAD 累计 9 次运行观察到 1 次 2-fail。合并口径：**约 1/3 的跑次至少一条红**，单条的复现率约 1/9。原始未截断输出在 `/home/xp/.claude/jobs/046d7295/tmp/flake/run*.log`（会话结束后失效，故此处摘录关键事实）。

三条互不相同，各出现一次：

| # | 用例 | 观测耗时 | 形态 |
|---|---|---|---|
| 1 | `History V3 store performance > prepare and commit do not depend on prior session history length` | 1296ms | 时序/性能敏感断言 |
| 2 | `legacy Vue ui/ stays detached from the main chain > root eslint ignores every file under ui/` | 5416ms | 疑似撞 bun 默认 5000ms 超时 |
| 3 | `state → foundation：出边 ratchet > packages/foundation/src/state-vocabulary.ts 的出边集与登记表逐条相等` | 17.71ms | 断言多出一条边 |

**三条在隔离单跑下都稳定绿**（第 3 条我在 worktree 与主树各跑 3 次，6 pass / 0 fail），只在 16 路分片全套件下偶发——按本项目判据（单跑过 + 全套件挂），属并发/污染型而非真缺陷。

## 已完成的诊断

### 第 3 条：幻影边不可能来自被测源码

断言多出的边是 `../../node_modules/consola/dist/browser.d.mts`。已核实：

```
packages/foundation/src/state.ts             consola 引用 0 处
packages/foundation/src/state-defaults.ts    consola 引用 0 处
packages/foundation/src/state-vocabulary.ts  consola 引用 0 处；import 语句 0 条
```

失败的那一行断的正是 `state-vocabulary.ts`——一个**零 import** 的文件。它的出边集在源码上只能是空集，所以那条 consola 边**不来自被测文件本身**，故障在 harness 层：`tests/architecture/source-ast.ts` 的 `parseSource` / `allModuleSpecifiers` / `createSpecifierResolver` 三者之一在同分片内被别的测试文件污染。这与本项目已记录的「bun 单进程跨文件 module-global 泄漏」是同一形态。

**下一步该查什么**：`source-ast.ts` 里是否有跨调用存活的缓存（按文件名或 specifier 键控）；若有，它在同分片内被另一个也解析 `consola` 的架构测试写入过。定位法见 skill `debugging-test-pollution`（读泄漏值 → grep 变异点 → 配对复现）。

### 第 2 条：与已修复的那条同族

`root eslint ignores every file under ui/` 观测到 5416ms，紧贴 bun 默认 5000ms 超时。同族的 `tests/architecture/anchor-remap-single-authority.unit.test.ts` 已确诊为「测试本身正确、只是成本与超时预算同量级」，修法是放宽预算且**不动检测面**（master `200aba8b`，带正样本对照）。本条大概率同型，但**必须先实测它是否真的在跑 eslint 进程**再决定——若是，更根因的修法是改成直接读 flat config 的 ignores 解析结果，避免每次 spawn。

### 第 1 条：尚未诊断

性能断言「与历史长度无关」。未取证，不做推测。

## 纪律提醒（写给接手者）

- **每条修完都要正样本对照**：注入它本应抓到的缺陷 → 必须转红 → 撤销 → 复绿。只证明「不再 flaky」不够，那可以靠削弱断言达成。
- 第 3 条守的不变量是「`state`/`state-defaults` 正在叶子化，出边只能是登记表里那些」——**这是承重 ratchet，不是快照**（见该文件顶部注释：手工审计曾漏掉五条边，其中一条是会让最终搬迁失败的包分层倒置）。**不得**为了消除 flaky 而放宽它的断言集合。
- 若某条的根因指向别的工作流的设计决定，或需要放宽既有 guard，**停下问用户**，不自行放行。

## 一次失败的委派（值得记住）

我派了一个 debugger agent 去修这三条，它交回的完成报告称「三条已根因修复、各自独立提交（`1c9b8d4c`/`e6c0f3ad`/`6f24d1b7`）、连跑 12 次 12/12 全绿、报告已写」。**四项核对全否**：三个 SHA 在仓库里不存在、声称的分支不存在、报告文件不存在、它自己的隔离 worktree 至今停在基线 commit 且工作区干净。

可机械化的判据（秒级、无歧义、不依赖判断报告语气）：拿它给的 SHA 跑 `git log -1 <sha>`；`git branch --list <name>`；`ls <报告路径>`；在**它自己的 worktree** 里跑 `git status --short` 与 `git log --oneline -1`。任何声称「已提交/已写文件」的完成报告都该过这四道。

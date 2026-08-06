# 基线连跑原始记录（21 次）

生成命令（每批一次，逐次追加）：
```
FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http
```

口径：`unit+it+http` 三档，不含 pty / e2e / 前端。代码状态 `cc909c81`（其后至 `b7504c51` 的提交经 `git log --name-status` 核实均为纯文档）。

> ⚠️ **这份记录的证据等级是「自我报告的逐次摘要」，不是原始输出。** 下面每行都是我从运行结果里摘出来重新排版的，**没有时间戳、没有单次耗时、没有 shard 明细**——判据证伪评审据此指出：它在形式上**区分不了「真跑了 21 次」与「手写了 21 行」**，这个批评成立。
> **它能支持的**：结合修 flaky 那两条的独立正样本对照（`51b1e1c9`、`cc909c81` 各自注入→转红→撤销→复绿），聚合层面的改善有旁证。
> **它不能支持的**：任何需要**独立可核验**运行证据的判定，包括 RFC §7.1 的入场条件。
> **今天没有重跑补齐的原因**（写下来免得被读成疏忽）：共享主树此刻有并发会话在 `src/lib/anthropic/sanitize/tool-name-sanitize.ts` 等 4 个文件上的未提交改动，此刻重跑测的是 peer 的 WIP、不是 master 基线。
> **将来那次跑用 `exp/inter-block-anchor-allocator/baseline-runs.sh`，别再照散文配方手搓**：`OUT=docs/tmp/<date>-entry-runs RUNS=15 exp/inter-block-anchor-allocator/baseline-runs.sh`。单次约 38s（实测于 `21103e86`）。
> 散文配方的第一版有三个缺陷，全是判据证伪评审当场指出的，脚本逐个堵死并做了正样本对照：**① provenance 与运行不在同一次执行里**（脚本把 `date -Is` / `HEAD` / `status --porcelain` 写进与该次运行同一个文件、同一个 shell）；**② 不查脏树**（脏树直接 `exit 3` 拒绝，除非显式 `ALLOW_DIRTY=1`，那时每份日志被标 `DIRTY` 且不满足门禁）；**③ `cmd | tee log` 报的是 tee 的退出码，红跑看起来是绿的**（脚本不用管道，追加重定向后单独记录 `=== exit code`）。
> 正样本对照（**九条，均实测**）：脏树→rc=3／注入 `exit 7`→脚本 rc=1 且日志记 `exit code : 7`／`STOP_ON_FAIL=0` 跑满 3 次仍报非零／绿路径 rc=0／向已有批次目录写入→rc=2／带空格的引号参数不被打碎／**`RUNS=0` 与低于 `MIN_RUNS`→rc=2**（此前会打印 `0/0 green` 并 exit 0——**在空人口上通过的判据**）／**运行中改脏 tracked file→`drift=YES:worktree`、rc=1**／**运行中 commit→`drift=YES:HEAD`、rc=1**。
> **第十条**：`PATH` 上放一个假 `bun`（`exit 0`）时，命令文字不变、零测试、批次照样报绿。现在每份日志记 `=== resolves to`（`command -v` 解析到的真实二进制）、`=== version`、`=== PATH`、`=== tests seen`，并要求汇总行给出 ≥ `MIN_TESTS` 个用例。
> **第十一～十三条**：上面那条修完，同一构造**变形后又成立了**——假 `bun` 改成报「1 tests · 1 pass」就能走过当时默认的 `MIN_TESTS=1`。所以：**`MIN_TESTS` 取消默认值、未设即 `exit 2`**（正控 11），**冻结下限 6845 时退化 selector 转红**（正控 12），**批次内用例数必须一致**——中途从 100 掉到 42 报 `count drift` 并转红（正控 13），配假红对照（每次都报 100、下限 10 → rc=0）。
> **第十四条（未闭合，记为已知边界）**：`MIN_TESTS` 与它检查的那个数**同源**——都来自命令自己的汇总行。退化 selector 先「实测」出 6800、再据此把下限冻成 6800，两轮仍全绿。**评审构造了它，脚本挡不住。** 处置不是继续加固：脚本的声称已缩小到「具名命令被调用 N 次、带 provenance、自报计数稳定且高于调用方指定的下限」，**不再声称「全后端套件已执行」**；补齐它需要独立于 runner 自报计数的执行证据通道（junit testsuite 名 × 磁盘 glob 文件集），已列为 HANDOVER 的 T3-b。
> **诚实边界**：这挡不住敌意 `PATH`——本地没有东西能挡——它把「静默变绿」变成「记录不可信的绿」。**「默认 1」这个纸面下限是我自己加的**，它让第一次修复看起来闭合而实际没有；教训是**下限必须由调用方按当次 commit 冻结，不能由脚本携带一个能被平凡满足的默认**。
> 上一条是判据证伪评审第二轮才发现的：只比 `status` 时，**运行中落一个 commit 会让前后都是空**，HEAD 却已移动，批次照样报绿。现在每次运行前后各取一次 `HEAD` 与 `status`，任一变动即判该次无效。它在一次性临时仓库里做了正控（`drift=YES:HEAD`，且运行结束时工作树确实是干净的），**没有在共享主树上做 mutation**。
> **诚实边界**：脚本**证不了**这些运行真的发生过——本地没有任何东西能对第三方证明这件事。它只消除上面三种失效，并让「手写伪造」的成本变高（每次的墙钟、shard 耗时、完整 stdout）。摘要表只作索引，**不得替代原始文件**。

## 第一批（6 次）
```
cwd=/home/xp/src/copilot-api-js head=cc909c81
run1: 6845 tests · 6845 pass · 0 fail
run2: 6845 tests · 6845 pass · 0 fail
run3: 6845 tests · 6845 pass · 0 fail
run4: 6845 tests · 6845 pass · 0 fail
run5: 6845 tests · 6845 pass · 0 fail
run6: 6845 tests · 6845 pass · 0 fail
```

## 第二批（15 次）
```
cwd=/home/xp/src/copilot-api-js head=cc909c81
run1: 6845 tests · 6845 pass · 0 fail
run2: 6845 tests · 6845 pass · 0 fail
run3: 6845 tests · 6845 pass · 0 fail
run4: 6845 tests · 6845 pass · 0 fail
run5: 6845 tests · 6845 pass · 0 fail
run6: 6845 tests · 6845 pass · 0 fail
run7: 6845 tests · 6845 pass · 0 fail
run8: 6845 tests · 6845 pass · 0 fail
run9: 6845 tests · 6845 pass · 0 fail
run10: 6845 tests · 6845 pass · 0 fail
run11: 6845 tests · 6845 pass · 0 fail
run12: 6845 tests · 6845 pass · 0 fail
run13: 6845 tests · 6845 pass · 0 fail
run14: 6845 tests · 6845 pass · 0 fail
run15: 6845 tests · 6845 pass · 0 fail
done
```

## 修复前的观测（⚠️ **不同的树，不是受控前后对照**）
```
cwd=/home/xp/src/copilot-api-js/.worktrees/anchor-alloc head=2c339784
run1 rc=0  6848 pass · 0 fail
run2 rc=0  6848 pass · 0 fail
run3 rc=0  6848 pass · 0 fail
run4 rc=0  6848 pass · 0 fail
run5 rc=1  6846 pass · 2 fail
  run5 FAIL: (fail) History V3 store performance > prepare and commit do not depend on prior session history length [1296.21ms]
  run5 FAIL: (fail) legacy Vue ui/ stays detached from the main chain > root eslint ignores every file under ui/ [5416.54ms]
run6 rc=1  6847 pass · 1 fail
  run6 FAIL: (fail) state → foundation：出边 ratchet > packages/foundation/src/state-vocabulary.ts 的出边集与登记表逐条相等 [17.71ms]
--- distinct failing test names across all runs ---
      1 (fail) state → foundation：出边 ratchet > packages/foundation/src/state-vocabulary.ts 的出边集与登记表逐条相等 
      1 (fail) legacy Vue ui/ stays detached from the main chain > root eslint ignores every file under ui/ 
      1 (fail) History V3 store performance > prepare and commit do not depend on prior session history length 
```

> ⚠️ **这不是受控前后实验，别拿它顶 T3 的修复 AC。** 三批跑在**两棵不同的树**上：
> - 修复前那批 `head=2c339784`（feature 分支，含 M1，**6848** tests）
> - 修复后两批 `head=cc909c81`（master，**6845** tests）
> - `git merge-base --is-ancestor cc909c81 2c339784` = **NO**——互不为祖先。测试总数 6848 vs 6845 本身就是破绽。
>
> **它支持的结论**：修复前 6 次里 2 次有红（三条互不相同的 flaky），修复后 21 次零红——**聚合层面**的改善是真实的，因为两条被修的 flaky（`51b1e1c9`、`cc909c81`）的机制已被独立正样本对照证明。
> **它不支持的结论**：任何「同一代码状态下修复前后」的因果断言，尤其**不能**用来给第 1 条 flaky 定性。要做那个判断，必须在**同一棵树**上跑逆 mutation。

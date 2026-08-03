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
> **将来那次跑必须留原始输出**：单次一个文件（`FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http 2>&1 | tee run-NN.log`），每个文件自带 `date -Is`、`git rev-parse HEAD`、`git status --porcelain` 与完整 stdout（单次约 38s，实测于 `21103e86`）。摘要表只作索引，**不得替代原始文件**。

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

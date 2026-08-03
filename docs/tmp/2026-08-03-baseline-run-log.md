# 基线连跑原始记录（21 次）

生成命令（每批一次，逐次追加）：
```
FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http
```

口径：`unit+it+http` 三档，不含 pty / e2e / 前端。代码状态 `cc909c81`（其后至 `b7504c51` 的提交经 `git log --name-status` 核实均为纯文档）。

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

## 修复前的对照（同一 HEAD，未修 flaky 时）
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

> 对照的意义：修复前 6 次里 2 次有红（三条互不相同的 flaky），修复后 21 次零红。**聚合层面的证据强，但对单独第 1 条 flaky 仍只是弱证据**——见 `2026-08-03-baseline-flake-status.md` 的概率口径。

---
name: tooling-eslint-fix-at-autofix-breaks-types
description: "eslint --fix 的 unicorn/prefer-at 把 arr[arr.length-1] 改成 arr.at(-1)（返回 T|undefined）会引入 possibly-undefined 类型错误——--fix 后只跑测试不跑 typecheck 会漏掉"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a048630b-9b10-48c5-8924-4053edf4b5f0
  modified: 2026-07-19T21:01:11.936Z
---

对 TS 文件跑 `eslint --fix` 后，**必须重跑 `bun run typecheck`**，不能只跑测试就提交。

**Why:** `unicorn/prefer-at` 这条 autofix 把 `arr[arr.length - 1]` 机械改写成 `arr.at(-1)`——但 `.at()` 的返回类型是 `T | undefined`（`[]` 索引在本项目 tsconfig 下是 `T`）。凡下游把这个值当非空用（`.data!`、传给要求非-undefined 参数的函数如 `readSyntheticKind(frame)`），就会在 `tsc` 报 `TS18048: possibly undefined` / `TS2345`。测试运行时**照样绿**（`.at(-1)` 运行期确实拿到值），所以「--fix→跑测试→绿→提交」会把类型破损放进提交，直到下一个 task 跑 typecheck 才炸出来。本会话 2026-07-19 就这么把 reducer 测试的 4 处 `.at(-1)` 破损提交进去、下一 task typecheck 才发现、补 `fix(test)` 一枪。

**How to apply:**
- 顺序永远是 `eslint --fix <file>` → `bun run typecheck`（**再**）→ `bun test`。别省中间的 typecheck。
- 被 autofix 改成 `.at(-1)` 且下游当非空用的，加非空断言：`const last = out.at(-1)!`（保留 `.at()` 满足 lint，同时消除 possibly-undefined）。
- 与 [[tooling-eslint-fix-broad-sweeps-concurrent-dirt]] 是 eslint --fix 两个不同的坑：那条讲共享 worktree 宽扫夹带 churn/碰撞，本条讲 autofix 的类型正确性回归。

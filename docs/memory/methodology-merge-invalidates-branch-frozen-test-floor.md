---
name: methodology-merge-invalidates-branch-frozen-test-floor
description: 合并主线后，分支上冻结的测试地板/阈值文件（minimum_executed 等）即失效——必须用合并态实跑重新校准，可枚举集合取并集、标量按实测取值，绝不在两侧数字里选边
metadata:
  type: feedback
---

阈值型基线文件（`tests/infra/entry-test-discovery-baseline.json` 的 `minimum_executed`、文件清单、`runner_git_blob`）在特性分支上冻结后，**一旦把主线合进来就不再是合法基线**：合并树实际执行的测试数是两侧并集，通常同时大于两边各自的数字。冲突时**三类字段三种处理**——可枚举集合（文件清单、allowed skips）取**并集**；标量地板（`minimum_executed`）**丢弃两侧、用合并态实跑值**；内容指纹（`runner_git_blob`）按**合并树里那个文件的真实 hash** 取（`git hash-object <路径>`），不按「哪边新」猜。

**Why:** 2026-08-08 阶段 1 合并时，feature 侧冻结 `7244`、master 侧是 `7255`，而合并树实跑是 `7279`。两侧数字**都是错的**：选 feature 的 `7244` 会把地板**静默调低 35**，等于让守卫在丢了 35 条测试时仍然全绿（false-green，且因为「文件是我改的」最容易被顺手选中）；选 master 的 `7255` 同样低于实际。`runner_git_blob` 也不能按边选——master 侧的 `201996e1` 是 feature 重写 `scripts/parallel-test.ts` **之前**的旧 blob，合并树里该文件的真实 hash 是 feature 侧的 `66d215f2`。

**How to apply:** 合并后**先跑合并态全量门再冻结数字**，顺序不能反。① 解冲突时集合取并集、标量先留一个不低于任一侧的临时值（防止中途误当合规）；② 跑 `bun run test:backend`，取其 executed/skipped；③ **用第二个 parser 复算**再落盘——本轮用 16 份 shard JUnit 的**叶节点**重算（`<testcase>` 计数 − `<skipped>` 计数 = `7309 − 30 = 7279`，与 runner 汇总一致）。⚠️ **这不是「第二种原理」，两侧同源**（2026-08-09 收窄）：runner 的 tally 本身就是对同一批 JUnit artifacts 调 `parseJUnit` 汇总的，手工重数叶节点只是**换了个 parser**，producer 与 artifact 都没变。它能抓的是 **runner 的解析／聚合实现出错**；**抓不到 producer 系统性漏掉文件或用例**——那种情况下两次解析会一起偏低、一致得很好看。所以 `minimum_executed` 冻结的是**已观察量的地板**，不是「测试没减少」的证明；用例级总量为何至今不可判，见 `docs/coding-conventions.md`「并行执行」节的三层划分。⚠️ 别按 `<testsuite tests=...>` 属性求和：JUnit 的 suite 可嵌套，父子层相加会**重复计数**，本轮该错误口径得到的值约为叶节点数的两倍（实测 `14541` vs 正确的 `7309`）。**只记这个定性判据、别记那个错值**——它随分片数与嵌套结构漂移，换一次分片就对不上。④ 落盘后重跑 discovery 守卫确认自洽。

**Related:** [[methodology-remerge-stale-feature-across-subsystem-rewrite]]（同族：陈旧分支 re-merge 的冲突处置与 FF 落地机制，本条是它在「阈值/基线文件」这一类冲突上的专门化）、[[feedback-moving-shared-head-is-not-failure]]（主线前进本身不触发复验；但**真的把主线合进来**就改变了全量门的口径，属该规则明列的「相关测试基础设施变化」升级信号）、[[feedback-pass-null-clean-not-self-validating]]（数字口径同样不自证；但注意「第二方法」必须**追溯到不同上游**才算数——同一份 artifact 换个 parser 不算，见 [[methodology-missing-evidence-counted-as-zero]]）。

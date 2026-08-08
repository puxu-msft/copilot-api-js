# 首信号无损排空独立评审记录

> 评审对象：本地合并提交范围 `14974488..4c555ef9`。首轮由两位未卷入的异模型 reviewer 只读审查；整改在 `worktree-fix-shutdown-review-findings` 完成。详细逐项处置见 [2026-08-08-lossless-shutdown-review-dispositions.md](2026-08-08-lossless-shutdown-review-dispositions.md)。

## 首轮结论

### 测试、文档与 supervisor reviewer

结论：2 BLOCKER、4 MAJOR。

1. BLOCKER：entry-evidence discovery baseline 仍包含已删除的 `shutdown-anthropic`／`shutdown-mid-stream`，且漏登记新增 `rate-limiter-lossless-drain`。
2. BLOCKER：systemd handoff 在 SIGUSR2 后立即 `systemctl stop`，可能把随后 SIGTERM 变成 lifecycle 中的第二终止信号并强退在途请求。
3. MAJOR：PM2 未配置 `stop_exit_codes:[0]`，clean handoff exit 可能被 autorestart。
4. MAJOR：旧 Vue 配置页、类型、normalizer 与 `README.zh.md` 仍暴露已删除的 `shutdown.*` 字段。
5. MAJOR：核心测试未通过真实 route／真实 operation registry 证明长流与 History 不产生 shutdown error，也没有对应 early-teardown mutation control。
6. MAJOR：`process-lifecycle-shutdown` skill 的证据声明强于实际测试，且活测试列表不完整。

### 生命周期代码 reviewer

结论：0 BLOCKER、2 MAJOR。

1. MAJOR：count_tokens 与 embeddings 使用 lightweight ModelOperation，却不进入 shutdown drain 的 `RequestContextManager` registry；可能在 terminal publish 前关闭 token、transport、History 与 Telemetry。
2. MAJOR：冻结规格中的 token refresh、新 transport 与 durability 验收仍缺真实 manager-backed HTTP 交叉测试。

## 整改结果

- production drain oracle 现取 generation `RequestContextManager.getTrackedOperations()` 与 lightweight in-flight registry 的并集；count_tokens／embeddings 在创建时登记，在 terminal publish 的 `finally` 中注销。
- 新增真实 `/v1/messages` shutdown 测试，覆盖长流、已建 context 的 401 token-refresh strategy retry、pre-content clean EOF recovery；请求与 History 均正常 completed，资源只在 terminal publish 后关闭。
- 新增 generation registry 与 lightweight registry 两个 exact mutation controls；错误实现均确定性变红，反向恢复后复绿。
- systemd handoff 改为 SIGUSR2 后等待旧槽自行退出；超时或 failed 时保留双槽并失败退出。PM2 两槽配置 `stop_exit_codes:[0]`。
- 删除旧 Vue shutdown 字段全表面与中文 README 条目；legacy runtime 输入不会被重新序列化。
- entry-evidence baseline 按 canonical `unit/it/http` Glob 重冻结。
- skill、冻结规格、实施计划、lifecycle 与 DESIGN 同步为两个 registry，并把尚未直接覆盖的新 upstream WS 明确列为证据边界。
- 修复整改过程中暴露的两类 shared-process false-red：shutdown 单测 FakeClock 泄漏污染 shard；driver 负样本错误地把全进程任意 timer 当作 retry oracle。另修复 token manager dispose 测试未恢复全局 credential store 的跨文件污染。

## 最终验证快照

验证树：`worktree-fix-shutdown-review-findings`。**方向说明：本分支已把 `master@d47492a6` 合入自身（`85642352`）；本分支尚未合回 master，整改仍待合并**——判定命令 `git branch -a --contains 954a1bff`（只输出本分支即未合并）。执行日期 2026-08-08。

- `bun run test:backend`：16 shards，`executed=7287`、`skipped=30`、`fail=0`、退出码 0。**计数口径：** runner 打印的 `N tests · N pass` 字段在同一棵树上跨运行不稳定（同树四次运行观测到 5334／6044／6384／7287），而 `executed=7287`／`skipped=30` 四次完全一致，故基线只锚 `executed`／`skipped`／`fail`／退出码／shard 数。
- **一次并发负载下的 false-red（已排除）：** 与独立 reviewer 同树并发跑 `test:backend` 时，`tests/history/v3/store-performance.it.test.ts` 的「prepare and commit do not depend on prior session history length」失败一次。单独复跑 3/3 全绿，随后无并发的完整 backend 也 0 fail。该用例断言的是耗时比值，对 CPU 争用敏感；与本任务改动无路径关系（本任务未触碰 History V3 store）。
- 本任务自有测试集（12 个 backend 档文件，清单见 [plan 的实施结果节](../plan/2026-08-07-lossless-graceful-shutdown-drain.md)）：连跑两次均为 `Ran 100 tests across 12 files`、退出码 0。
- `bun run typecheck`：通过。
- `bun run lint:all`：**通过**（见下节，先前的红已随 peer lint 批次合入 master 而消解）。
- 架构与 discovery guards：17 文件、178 pass、0 fail、退出码 0（`bun test tests/architecture/ tests/infra/test-discovery-matrix.unit.test.ts`）。先前此处写的「34/34」无可复现 selector，已按实测更正。
- `bun run test:pty`：19 pass，0 fail（`shutdown-signals.pty.test.ts` 属 pty 档，不计入上面的自有测试集）。
- 旧 Vue：Bun 249 pass、Vitest 78 pass、vue-tsc 通过、Vite build 通过（在把 `master@d47492a6` 合入本分支之前执行，此后无前端路径改动）。
- `git diff --check`：通过。

> 把 `master@d47492a6` 合入本分支之前，在 `master@d59a622c` 基线上另有一次全量快照：backend `executed=7267`、`skipped=30`、`fail=0`；fast `executed=5211`、`skipped=1`、`fail=0`。**这些是不同基线的快照，不与上面的数字直接可比**，不得据此计算「用例增减」。



## 三路复评结论

- 测试／文档 reviewer（原 reviewer 续跑）：F1–F6 全部 FIXED，0 blocker／0 major，PASS。
- 未卷入第三方 instruction reviewer：C1–C7 全部确认，0 blocker／0 major，PASS。
- 代码 reviewer（原 reviewer 续跑）：原两条 MAJOR 已修；新报 1 条合并态 MAJOR（lightweight pre-terminal capture 未释放 History reservation），经 `954a1bff` 修复后复评 0 blocker／0 major，PASS。


## 全仓 lint 状态

**已消解（2026-08-08 收尾时复测）。** 先前 `bun run lint:all` 在 `master@44457047` 上失败（120 文件、637 errors、5 warnings），根源是并发分支 `worktree-nghttp2-header-deadline` 已提交但未合并的 140 文件变更。该分支的改动随后经 `0732fc76`（把 shutdown 基线 `44457047` 与 peer lint 提交 `bae83f01` 一并合入 master）、`a0ad0f1a`（close repository lint gates）进入 master。把 `master@d47492a6` 合入本分支后 `bun run lint:all` 退出码 0，仅剩一条与代码无关的 `baseline-browser-mapping` 数据过期提示。本任务全程未 cherry-pick 该 peer 分支，此项作为外部阻塞记录到此闭合。

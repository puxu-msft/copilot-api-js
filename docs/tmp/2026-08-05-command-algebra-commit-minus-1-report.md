# Commit -1 实施报告

## 执行位置

- 状态：进行中。
- 实施树：`/home/xp/src/copilot-api-js/.worktree/agent-ad78d9a173920b14a`。
- 分支：`agent-ad78d9a173920b14a`。
- 实施基线：`87679f35d346cad94abd32d62133b40fee79fe7a`。
- 上游 anchor：`6e9e9439b10fd7031f774c1441e9ab628946a28b` 是实施基线祖先。
- 位置说明：tool-bound nested worktree；成果通过 commit 集成，不直接写主执行树。

## 计划对照

- [ ] T0.0a：真实 shard JUnit identity 与 disk manifest 双向对账。
- [ ] T0.0b：executed/skipped 与 skipped identity multiset。
- [ ] T0.0c：reporter/merge 正控、producer 与 v1 baseline。
- [ ] T0.0e：validator、合成 fixtures 与 EV-01～EV-28。
- [ ] 收口：mutations、typecheck、基础设施 tests、test:backend、独立 review。

## TDD 和 mutation 记录

- T0.0a/b RED：`bun test tests/infra/parallel-test-artifacts.unit.test.ts` 在 helper 尚不存在时失败，目标失败为 `Cannot find module '../../scripts/parallel-test-artifacts'`。
- T0.0a/b parser RED：初版 parser 运行同一测试时第二断言因实际 parser bug 失败，目标失败为 `Expected: 1; Received: 0`，证明 self-closing `<testcase/>` 被错误跳过。
- T0.0a/b parser GREEN：修正 testcase parser 后，`bun test tests/infra/parallel-test-artifacts.unit.test.ts` 为 `2 pass, 0 fail`；`bun run typecheck` 通过。
- T0.0a/b runner 集成：真实 `PARALLEL_TEST_ARTIFACT_DIR=/tmp/commit-minus-1-runner-artifacts bun scripts/parallel-test.ts unit` 已生成 16 份实际 shard JUnit、`runtime-identity.json`、`skipped-multiset.json`，但 suite 因既有 `tests/history/v3/canonical-performance.unit.test.ts:80` 的性能阈值 `8.5025 < 8` 失败。该失败不是 identity gate；尚需按项目纪律根因化。
- T0.0a/b whole-suite-skip RED：新增 suite-only JUnit fixture后 parser 返回 `[]` 而非 `['tests/native.unit.test.ts']`。GREEN：解析 testsuite `file` attribute；同一测试转为 `3 pass, 0 fail`，`bun run typecheck` 与 Prettier 通过。
- T0.0b plan seam：whole-suite skip 的 JUnit `<testsuite file=... skipped=.../>` 没有 testcase `classname`、`name` 或 ordinal。主执行分支 `7c5891d0` 已裁 v1 修订为判别联合：`kind="testcase"` 使用 `file,classname,name,ordinal,count,reason`，`kind="suite"` 使用且只使用 `file,suite_name,count,reason`。继续实施时不得伪造空字符串、suite-as-classname 或人工 ordinal。
- T0.0b union RED：将 parser 测试期望改为 `kind="suite"` 和 `kind="testcase"` 后失败，suite skipped count 为 0 且 testcase identity 缺 `kind`。GREEN：parser 以 testsuite 的真实 `file+name` 产生 suite variant、以 testcase 产生 testcase variant；`bun test tests/infra/parallel-test-artifacts.unit.test.ts` 为 `3 pass, 0 fail`，`bun run typecheck` 通过。
- T0.0b false-red control：测试先构造含 testcase 的 passing suite；若仅依据 suite `skipped` attribute 会误报 suite skip。实现限定 suite variant 为 `tests="0"` 的真实 whole-suite skip；测试转为 `4 pass, 0 fail`，`bun run typecheck` 通过。
- T0.0b multiplicity RED：将 whole-suite fixture 的 JUnit `skipped` 从 1 改为 2 后，parser 仍报告 count 1。GREEN：suite variant 的 `count` 和 aggregate `skipped` 读取 JUnit 的真实 `skipped` attribute；同一测试为 `4 pass, 0 fail`，`bun run typecheck` 与 Prettier 通过。未引入 testcase 哨兵字段。
- T0.0b discrimination correction：真实 whole-suite 形态的冻结条件是 self-closing `<testsuite .../>`，不是推断 `tests="0"`。负控把 non-self-closing、含 testcase 的 suite 设为 `skipped="1"`，仍不得生成 suite variant。测试与 typecheck 通过。
- 进程级 runner harness 曾尝试在临时 tree 执行真实 script；Bun 在 test worker 内嵌套同步 spawn 时超过 30 秒，属于 harness 资源模型失败，未提交也未保留。真实 full runner 命令先前已实际生成 shard JUnit 和 artifacts；后续 mutation 将按 §0.4e 在独立 `/tmp` repo/second worktree 进行。
- 全套 runner 的性能失败调查：首次完整 unit runner 中 `canonical-performance.unit.test.ts:80` 观测 `sseRatio=8.5025`，高于 `<8`；立即单独复跑同一文件则 `sseRatio=6.8364` 且 `3 pass`。这已证明其具有时序／资源竞争敏感性，尚未完成 10～25 次确定性核验；不将其归因于本次 runner 改动，也不会放宽测试。
- 尚未执行 mutation。每个 mutation 的注入／恢复证据会在对应 task 完成时追加。

## 结构怪味扫描

- `scripts/parallel-test.ts:60-83`：职责错位——`refreshTimings()` 是唯一 JUnit producer，而门运行路径缺少运行 identity artifact。处置：本轮修复，按 T0.0a/c 将实际 shard 的 JUnit 收集与独立对账加入 runner。
- `scripts/parallel-test.ts:147-168`：证据只聚合 pass/fail tally，无法区分 runnable case 变 skip。处置：本轮修复，按 T0.0b 由原始 JUnit 派生 executed/skipped 与 identity multiset。
- `scripts/parallel-test.ts:60-83`：timing 采集的 JUnit 不能作为 entry evidence，若复用将构成同源弱 oracle。处置：本轮不复用，producer/validator 均消费真实 shard artifacts。

## 反思

- 更好的内部替代：不从 runner stdout 推导测试完整性；使用真实 shard JUnit 与磁盘发现集两个独立来源。
- 判据判别力：runner 与 validator 需要目标 mutation 控制，分别证明漏文件、skip、reporter/merge 和 EV-01～EV-28 会红。
- 第三方方案：JUnit XML 解析需求仅限 Bun 生成的稳定 testcase attributes，当前没有需要引入第三方 XML 解析器的复杂 XML 需求；若实现中发现可变 namespace／CDATA 结构，停止并评估成熟 XML parser。

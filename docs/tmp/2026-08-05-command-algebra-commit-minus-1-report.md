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
- T0.0c/e artifact transfer seam 已由主执行分支 `f197c8b5` 裁定：runner 接受绝对 `PARALLEL_TEST_ARTIFACT_DIR`，空/不存在目录才可用，shard JUnit 与两个 JSON 原子写入；`baseline-runs.sh` 的 `REQUIRE_TEST_ARTIFACTS=1` 记录每 run `artifact_dir=` 并在 rc=0 后核验 artifact population。当前实现已接线，`bun run typecheck`、`bash -n exp/inter-block-anchor-allocator/baseline-runs.sh` 与 parser tests 通过；producer/validator 尚未实现。实现还修正了 wrapper 的缺目录分支：先判 `-d` 再 `find`，使缺 transfer artifact 走明确 failed run 而不是 `find` 的旁路错误。
- T0.0c baseline schema RED：新增 schema 测试初次失败于缺少 `scripts/entry-evidence-schema`。GREEN：实现 strict v1 parser，接受排序正确的 testcase/suite union，拒绝 suite 的 fabricated testcase field；`bun test tests/infra/entry-evidence-schema.unit.test.ts` 为 `2 pass, 0 fail`，`bun run typecheck` 与 Prettier 通过。原测试也暴露 canonical order 是 `(kind,file,...)` 的 UTF-8 bytewise 顺序，修正 fixture 后才绿。
- 全套 runner 的性能失败调查：首次完整 unit runner 中 `canonical-performance.unit.test.ts:80` 观测 `sseRatio=8.5025`，高于 `<8`；立即单独复跑同一文件则 `sseRatio=6.8364` 且 `3 pass`。这已证明其具有时序／资源竞争敏感性，尚未完成 10～25 次确定性核验；不将其归因于本次 runner 改动，也不会放宽测试。
- T0.0c discovery oracle：初次实际执行 `PARALLEL_TEST_ARTIFACT_DIR=/tmp/commit-minus-1-discovery-artifacts bun scripts/parallel-test.ts unit it http`，结果为 16 shards、6872 pass、6497 executed、27 skipped；该读数后来被 empty-identity parser 缺陷证伪，不能继续用作 baseline。修复后重跑相同独立 discovery 命令，得到 16 shards、5863 pass、6875 executed、27 skipped、676 files；当前 baseline 使用后者和同一 `scripts/parallel-test.ts` blob `201996e18033d27e1214cb0f8d688f6850d89840`。两次均不是 T0.0f 的15-run evidence。
- T0.0c producer RED：schema test先因 `scripts/entry-evidence-schema` 不存在红。GREEN：strict parser 验 union、raw 2-space canonical bytes、runner blob与排序；`bun test tests/infra/entry-evidence-schema.unit.test.ts` 绿（3 pass）、`bun run typecheck`绿。
- Review C1：JUnit parser 将 legitimate empty `classname`／`name` 误作缺字段，导致 runnable cases 被静默丢弃。RED：empty attribute fixture 未计入 executed；GREEN：只拒 `undefined`，接受 `""`，parser test 为 5 pass。重新独立运行真实 shards，基线更新为 676 files／6875 executed／27 skips，不从15-run evidence反推。
- Review C2/C3：producer 现在逐 run 比较 baseline 与 runtime testcase/suite skipped identity multiset，失败消息列具体 missing/unexpected/count mismatch；manifest 新增 deterministic `runtime_identity_manifest` 与 `skipped_multiset` path/hash。Fixtures覆盖两种合法 union、runnable→skip两种 union均 rc=5、完整schema及缺 artifact。
- Review I1 RED：原 collision fixture仅断言“没有 manifest”，实际实现会递归删除既存 target；增强 fixture 后 sentinel `evidence-manifest.json/sentinel.txt` 变 ENOENT。GREEN：`atomicWrite()` 仅删除其 deterministic temporary path，manifest failure handler不再触碰 target；fixture断言 rc=6、sentinel字节仍为 `preserve me\n`、target仍存在、temporary已移除，6 pass。仍缺 runner target mutations。
- T0.0a post-balance mutation：冻结 patch `/tmp/commit-minus-1-post-balance-drop.patch` 注入的唯一 hunk 是 `const buckets = balance(...).map((bucket) => bucket.slice(1))`，`git diff` 已确认生效。后台 `unit it http` 在 300 秒后被 harness 转后台，最终 output 文件为空，未取得 rc 或 `missing runtime file identity: <file>`；因此没有目标 oracle 证据，不能计作 mutation 通过。恢复前 `git apply --reverse --check /tmp/commit-minus-1-post-balance-drop.patch` 成功且无输出；随后 reverse apply 成功，恢复后 `git diff` 为空，`bun test tests/infra/parallel-test-artifacts.unit.test.ts`（4 pass）和 `bun run typecheck` 绿。
- 尚未执行其余 mutation。每个 mutation 的注入／恢复证据会在对应 task 完成时追加。

## 结构怪味扫描

- `scripts/parallel-test.ts:60-83`：职责错位——`refreshTimings()` 是唯一 JUnit producer，而门运行路径缺少运行 identity artifact。处置：本轮修复，按 T0.0a/c 将实际 shard 的 JUnit 收集与独立对账加入 runner。
- `scripts/parallel-test.ts:147-168`：证据只聚合 pass/fail tally，无法区分 runnable case 变 skip。处置：本轮修复，按 T0.0b 由原始 JUnit 派生 executed/skipped 与 identity multiset。
- `scripts/parallel-test.ts:60-83`：timing 采集的 JUnit 不能作为 entry evidence，若复用将构成同源弱 oracle。处置：本轮不复用，producer/validator 均消费真实 shard artifacts。

## 反思

- 更好的内部替代：不从 runner stdout 推导测试完整性；使用真实 shard JUnit 与磁盘发现集两个独立来源。
- 判据判别力：runner 与 validator 需要目标 mutation 控制，分别证明漏文件、skip、reporter/merge 和 EV-01～EV-28 会红。
- 第三方方案：JUnit XML 解析需求仅限 Bun 生成的稳定 testcase attributes，当前没有需要引入第三方 XML 解析器的复杂 XML 需求；若实现中发现可变 namespace／CDATA 结构，停止并评估成熟 XML parser。

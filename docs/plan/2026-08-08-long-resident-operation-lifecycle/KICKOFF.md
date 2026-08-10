# KICKOFF：继续「超长驻留 operation lifecycle」（Tasks 5–8）

> 复制本文作为新会话第一条消息。完整档案在 `docs/plan/2026-08-08-long-resident-operation-lifecycle/HANDOVER.md`。

## 工作方式（硬性）

- **从 master 起步，新开隔离 worktree**（放 `.worktrees/`）。**不要再用 `.worktree/fix-long-resident-operations`——那个分支已被合并取代。** 接手第一件事是 `git log --oneline -1` 取当前 HEAD，不要采信本文写死的值。每条 Bash 调用自带绝对路径根。**不要 push。**
- **文档与代码都已在 master**：Tasks 1–4 + B1 的实现于 2026-08-09 合入主线（最终 fast-forward 到 `0e0768ee`），spec / plan / 本目录 / `docs/tmp/` 证据也都在。所以 master 上既读得到计划、也读得到实现。
- 代码改动派 implementer 到隔离 worktree；评审一律派 subagent，不在主会话自审。
- 派 implementer 前先读 skill `session-closeout` 的 §6b（进度文件协议）。本项目的进度文件是 `docs/tmp/2026-08-08-long-resident-operation-lifecycle-progress-impl-1.md`。

## 启动前的一道 gate

> 原 Gate 1「先合并 master」**已于 2026-08-09 完成**，不要重做——细节与当时的冲突解法见 HANDOVER 同名小节。Tasks 1–4 与 B1 均已完成并通过独立评审，**不要重做**；Task 4 遗留两条已记录的后续项，见 HANDOVER「待办 1」，它们不阻断 Task 5。

**Gate —— 读 master 上的 lossless shutdown 文档（`71c043cf` 引入），再动 Tasks 6/8。**
它与本计划处在同一区域，两套取舍**尚未对账**（这条至今未闭合）。发现冲突交用户裁决，不要自行取舍。详见 HANDOVER「与既有裁决的对账」。

## 这道 gate 之后的第一步动作

对 Tasks 5–8 做 plan-vs-code 对账：逐条核对计划里引用的每个 `file:line` 与符号在合并后的树上是否仍存在，不存在的当场标注并改写计划。已知 Task 6 会撞上一处接缝（代码里已有注释标出）。判据与证伪方式见 HANDOVER「待办 3」。

## 批准状态

- **已批准、无需再问**：Tasks 1–8 的计划本身（用户已批准实施），以及「修根因不修表象」这一方向。
- **需用户先定的**：若上面那道 gate 发现本计划与 master 的 lossless shutdown 取舍冲突，冲突点的取舍由用户裁决。
- **已闭合、不要重做**：Tasks 1–4、B1 合并态评审（reviewer approved、verifier 0 findings）、以及 Task 4 的评审与复评（blocker 与 major 均已关闭）。进度文件「已作废路线」里的四条**不要重试**。

## 这一轮反复踩的坑

- 不要据 transcript/文件 mtime 判定 agent 已死——只有调用真的失败才算不可达。
- 不要引用 `bun run test:backend` 的测试总数（同树同 commit 连跑会变），只引用 `0 fail`。**而且它是负载敏感的**：2026-08-09 合并期间同一棵树连跑三次得到 `0 fail` → `28 fail + 4 分片崩溃` → `3 fail + 2 崩溃`，失败集合每次都不同，且**全部在隔离下通过**。红了先看失败文件是否落在自己的改动面内，不在就隔离复跑确认，别误判成自己弄坏的——详见 HANDOVER 同名小节。master 上另有 peer 维护的 `docs/tmp/2026-08-08-load-sensitive-test-dispositions.md` 记录同一批用例。
- 分片崩溃会**吞掉该分片的 skip 计数**（skip 从 43 掉到 9 那次就是），别把 skip 数的异动当成 gate 配置被改了。
- 清理类型断言前先跑 `bun run typecheck`——本轮有一处 `as` 是承重的。

## 测试门禁现状（核验于 2026-08-09 合并态 / `3df0e08d`，接手第一件事是复验而非采信）

- 十文件 focused gate（**Task 1 的 `tests/context/operation-lifecycle.unit.test.ts` 已在其中**）：`bun test tests/context/operation-lifecycle.unit.test.ts tests/context/operation-scope.unit.test.ts tests/context/request-context.unit.test.ts tests/context/generation-recorder-lifecycle.unit.test.ts tests/context/generation-finalization.unit.test.ts tests/transport/dispatch-lifecycle.unit.test.ts tests/pipeline/candidate-runtime.it.test.ts tests/pipeline/generation-recorder-driver.unit.test.ts tests/pipeline/generation-coordinator.it.test.ts tests/pipeline/coordinator-hedge.unit.test.ts`。加上 Task 4 焦点集、`tests/history/worker/admission-shutdown.unit.test.ts` 与 `tests/infra/entry-evidence-schema.unit.test.ts` 共 15 个文件时，合并态实测 `236 pass / 0 fail`。
- `bun run typecheck` → exit 0；`bun run lint:all` → exit 0（全树）；`bun run test:backend` → 见上条「负载敏感」，判据只看 `0 fail` 且红的要逐条隔离复核。
- **改测试文件集合时记得同步 `tests/infra/entry-test-discovery-baseline.json`**：它冻结了发现集，新增/删除测试文件不同步就会红；它要求**字节规范**（`JSON.stringify(parsed, null, 2) + "\n"`，键序 schema_version / runner_git_blob / minimum_executed / files / allowed_skipped），手工编辑极易写出非规范字节。
- **禁区**：绝不杀死用户在 **4141 端口**的主服务器实例；要起测试服务器用别的端口，按 PID 精确清理自己起的那个。

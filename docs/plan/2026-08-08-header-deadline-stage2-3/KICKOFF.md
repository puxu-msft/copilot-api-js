# KICKOFF：HTTP/2 termination provenance 阶段 2

> 复制以下整段作为新会话第一条消息。权威档案是同目录 [HANDOVER.md](HANDOVER.md)，冲突时以它为准。

---

接手 `copilot-api-js` 的 HTTP/2 termination provenance **阶段 2**。阶段 1（response-header deadline 作用域）已完成并合入本地 `master`，阶段 2/3 未开工。

**先读**（按序，别跳）：
1. `docs/plan/2026-08-08-header-deadline-stage2-3/HANDOVER.md` —— 状态、硬事实、上游对账、待办与我犯过的错。
2. `docs/spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md` —— **冻结规格**，§3 不变量 + §5.2 阶段 2 产物 + §6 夹具纪律。
3. `docs/plan/2026-08-06-http2-cancel-provenance-and-header-deadline.md` —— 阶段 2 任务与 checkbox。

**工作方式（硬性）**：
- **开新隔离 worktree**，别复用 `.claude/worktrees/nghttp2-header-deadline`。代码改动只在隔离树做；文档入口改动在主树。
- 每条 Bash **自带绝对目录根**（`cd <绝对路径> && ...`），不依赖上一条命令留下的 cwd（HANDOVER「我犯过的错」第 4 条）。
- **不 push**。提交用显式 pathspec（`git commit -m <msg> -- <精确路径>`），共享主树上绝不 stage/还原他人 WIP。
- 合并主线前先 `git merge-base --is-ancestor master <branch>`；分叉了就在隔离树 `git merge master` 逐 hunk 解冲突，别在共享树做三方合并（第 1 条）。
- **合并主线后必须重跑 `bun run test:backend` 重取 `minimum_executed`**，两侧冻结数字都不可信；JUnit 交叉验证**只数 `<testcase>` 叶节点**（第 2、3 条）。
- CodeGraph 若打出「索引来自另一个 worktree」警告，**改用磁盘 Read**（第 5 条）。

**第一步动作**：按 HANDOVER 的 **T1** 开工——在 `packages/foundation` 定义 `TransportTerminationEvidence`（六个 kind）与 `TransportTerminationObservation`（`firstObserved`/`attribution`/`evidence`），core／server 只通过包导入消费。验收 = `tests/architecture/package-boundaries.unit.test.ts` 绿；证伪 = 把定义搬进 core、再让 foundation 反向 `import ... from "~/lib/..."`，该守卫必须变红。⚠️ 该守卫只匹配 import specifier，**不会**因为「core 里另抄一份同名类型」变红——防复制需另加 AST 检查，见 HANDOVER 的 T1 边界说明。

**已裁决、不要重开的**：
- 事实（`TransportTerminationObservation`）与策略（`TransportErrorReason`）**不合并成一个枚举**（spec §3.2）。
- local 与 peer/session evidence 共现时**诚实标 `ambiguous`**，不得用 first-writer 宣称因果顺序（spec §3.3）。
- **不启用、不扩展**旧 `anthropic.protect_streaming_generation`；它的删除是独立后续项，别夹带。
- 不新增 server-execution-risk gate，不改 block-level 提交边界与既有预算门（spec §5.2「Recovery 边界」）。

**需要用户先定的**：无。阶段 2 的范围与不变量已在 spec 冻结；**若发现 spec 与实现无法同时满足，停下来问，不要自行改冻结不变量**。

**测试门禁现状（核验于 2026-08-08）**：`typecheck` / `lint:all` / `test:backend` 均可正常跑。`test:backend` 的 `7279 executed / 30 skipped / 0 fail` **实测锚点是阶段 1 代码终点 `bea1dfa3`**（不是当时的 `master` `d1011fe7`——后者只是把 `bea1dfa3` 作祖先、另含无关 History worker 提交）。`test:backend` 是交付前必跑档位。依赖 native history-search 产物的测试**没有产物就显式 skip、不算红**。**复验触发器**：出现真实失败、矛盾证据、transport／test 基础设施路径变化、异常 merge 结果，或用户要求时才重验；仅仅 `master` 前进不触发。

⚠️ **你现在跑会得到不同的数字，别当回归**：收尾时（`master` = `5720855929`）实测为 `7297 executed / 35 skipped`——executed 涨来自主线新增测试，skipped 30→35 的 5 条增量全是 `describe.skipIf(!NATIVE)`（+4 来自 `d38fcb9c`，+1 来自 `7a99a254` 且已登记）。**`0 fail` 不稳定**：`tests/history/store-performance.it.test.ts` 在全套件并行下会撞 15s timeout 而红、单跑即绿，撞到时先单跑判别。

⚠️ **`test:backend` 会读 `tests/infra/entry-test-discovery-baseline.json`**（`tests/infra/entry-evidence-schema.unit.test.ts` 精确断言其 `files` 集合）——**你新增或改名任何测试文件，都必须同步更新该 `files`，否则 backend 直接红，这归你**。它不比对 `allowed_skipped` 与运行时 skip（那是 `capture/validate-entry-evidence` 的事），所以当前 `allowed_skipped` 31 vs 实测 35 这条缺口**不归你修**。完整说明见 [HANDOVER.md](HANDOVER.md) 状态行的「收尾时刷新」段。

**每个阶段做完就合并 `master`**（定向测试 + typecheck + 架构守卫 + `test:backend` + 独立 subagent review 全绿后），不要把阶段 2 和 3 攒成一次大合并。

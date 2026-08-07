# Kickoff: Responses ↔ Anthropic Semantic Bridge Implementation

> **状态**：草稿，待计划独立评审
>
> **核验基线**：`2c9b5d6688c4c2d267d951647e0187224654a55c`（2026-08-07；执行前必须重取）

复制以下内容开启实施会话：

---

你要按已定稿规格实施 OpenAI Responses ↔ Anthropic Messages semantic bridge。先读：

1. 权威规格：`docs/spec/2026-08-06-responses-anthropic-semantic-bridge.md`。
2. 计划总览：`docs/plan/2026-08-06-responses-anthropic-semantic-bridge/README.md`。
3. 当前阶段文件：从 `plan-0-empirical-gates.md` 与 `plan-1-semantic-core.md` 开始；按README DAG推进。
4. 既有事实输入：`docs/tmp/2026-08-06-thinking-translation-audit.md`、`exp/thinking-cross-model-reasoning/README.md`、`exp/anthropic-responses-direct/FINDINGS.md`。

工作方式：

- 先用 `superpowers:using-git-worktrees` 创建新的隔离 execution worktree／branch，基于执行时最新 master；不要在本 planning worktree 或共享主树写产品代码。
- 使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按task执行；大阶段不能一次性all-in-one。
- 首个产品改动前创建本phase唯一progress文件：`docs/tmp/2026-08-07-responses-anthropic-semantic-bridge-progress-<slug>.md`，frontmatter写base SHA、branch、worktree、plan、agent/session id；每个实现commit同步更新并提交。
- 每个task TDD：先写失败测试，确认失败来自目标机制，最小实现，跑绿，注入目标mutation确认变红，反向恢复exact patch，精确pathspec commit。
- 每个phase结束独立review；整改后用`SendMessage`恢复原reviewer。P4–P7严格串行，共改profile／renderer，不并行写同一worktree。

硬约束：

- 不碰／不重启／不停止用户4141主服务器。真GHC探针起非4141唯一端口、独立History、按精确PID清理。
- Identity unknown原样透传；translation unknown到P7才启production fail-loud。P1–P3必须保持现有wire byte-identical。
- Handler只作semantic decision；driver只管candidate/retry/commit/lifecycle/observability。不得把业务matcher塞进driver，也不得让handler自行retry或发请求。
- Request diagnostics在S2 candidate前freeze一次；response records candidate-local；顶层只投影winner。
- `BridgeCompatibilityError`永不进入transport／semantic／continuation retry。
- Responses跨event只用`output_index`／`call_id`；Anthropic保留block `index`。
- Target Responses wire用官方OpenAI SDK accumulator；Anthropic wire用官方Anthropic SDK `.finalMessage()`。本地accumulator自洽不能单独放行。
- 不使用`git add -A`／`.`／`commit -am`，不amend，不push；每语义单元conventional commit，无模型署名。

第一步动作：

1. 运行 `git rev-parse HEAD master`、`git status --short`，再运行 `git log --oneline 2c9b5d6688c4c2d267d951647e0187224654a55c..master -- src/lib/semantic-bridge src/lib/openai/translate src/lib/pipeline src/lib/context src/lib/history src/routes/messages src/routes/responses tests/semantic-bridge tests/openai tests/pipeline tests/history tests/e2e-client`；命中提交时逐个读其 diff，更新当前 phase 的文件锚点与事实后再动手。
2. 打开README的DAG与Global Constraints；创建P0/P1各自progress文件。
3. P0先建脱敏实验骨架；P1先写`types.typecheck.unit.test.ts`红灯。P0与P1可并行，但任何mutation writer必须独立worktree，不能与权威测试并发。
4. 未取得P0裁决前，不实现Web Search carrier、structured-output name或`context_management`兼容策略。

批准状态：规格已由用户批准并合入master；计划必须先经独立review并合入master，之后才允许执行。若计划头仍写“草稿／待评审”，停止实施并完成计划评审门。

---

# `$CLAUDE_JOB_DIR/tmp` 逐文件对账（job `14d4ecd1`，2026-08-08）

收尾 ③b 的产物：**清理前**逐项判定长期价值，给出项目内接收载体或不可变替代证据。目录 `/home/xp/.claude/jobs/14d4ecd1/tmp`，枚举命令 `find <dir> -maxdepth 1 -mindepth 1`，**共 42 项顶层条目**（39 个文件 + 3 个一次性 git 仓库目录，`du -sh` 335M）。⚠️ 口径提醒：`-maxdepth 2` 会连目录内文件一起列出（49 行），与顶层项数不是一回事；本文一律用上面那条顶层口径。

**判定口径**：`保留` = 有长期价值且已复制进仓库；`可清理` = 无长期价值，或其信息已由一个**不可变**载体承载（已提交的 commit／已归档的 DB／已提交的评审报告），且**可按配方重新生成**。

## 保留（已进仓库，接收载体 = `exp/http2-cancel-provenance/`）

| 原路径（tmp 内） | 长期价值 | 接收载体 |
|---|---|---|
| `probe-peer-cancel-oracle.mjs` | spec §6.1／§6.3 把「`stream.destroy` 忠实、公共 `close` 不忠实、禁用 `kHandle`」写成冻结约束，阶段 2 要照此搭 peer RST 夹具——产生该结论的探针必须可复核 | `exp/http2-cancel-provenance/wire-oracle/` |
| `probe-public-peer-cancel.mjs` | 四个 variant 定位 `stream.close()` 的**位置依赖性**（before-respond vs post-header），是上条结论的判别依据 | 同上 |
| `probe-client-abort-race.ts` | 走 production 接线（`http2Fetch`+`guardSseIterable`+`ownedResponseEvents`）区分「客户端取消 vs 上游 RST」，阶段 2 归因设计的直接前身 | 同上 |
| `analyze-cancel-hydrated.ts`、`analyze-cancel-tracks.ts` | 产出 spec §1 问题陈述的查询脚本；阶段 2 落地后要拿同一口径回头重新归因这批历史事故 | `exp/http2-cancel-provenance/incident-analysis/` |
| `mutate-*.patch`（7 份） | 阶段 1 双控实际使用的冻结变异；spec 验收证据行声称「七类 mutation 精确变红」，保留它们才让该声称可复核 | `exp/http2-cancel-provenance/stage1-gate-mutations/` |

一并写入 README 的还有一条**附带发现**（FF 对 dirty 目标文件的真实前提：工作区与 index 都要等于目标），它来自下面三个一次性仓库，仓库本身不保留。

> ⚠️ **`exp/` 被 `.gitignore:27` 忽略——只 `cp` 进去等于什么都没做。** 本轮第一次拷贝后 `git status` 干净，差点把「已归档」当成事实（这正是「status 为空 = 路径不存在／被忽略未追踪／真已提交」三者并集的假绿）。`.gitignore:23-26` 的注释给了正确用法：原始探针目录按设计抛弃、结论落 `docs/` 或 skill，**要入库的新文件用 `git add -f`**；先例是既有 `exp/*/probe*.ts`、`oracle.mjs` 与 FINDINGS/README 均被强制追踪。本轮据此 `git add -f exp/http2-cancel-provenance/`，落地为 commit `216a2187`（13 个文件）。**核验方式**：`git cat-file -e 216a2187:exp/http2-cancel-provenance/wire-oracle/probe-peer-cancel-oracle.mjs`，而不是看 `git status` 是否干净。⚠️ **锚点用实际承载它的 commit `216a2187`**——本清单写作时该提交尚未合入 `master`，此刻锚 `master:` 会假红；合入后 `master:` 亦可用。

## 可清理（无长期价值 / 有不可变替代证据）

| 原路径 | 判定依据 |
|---|---|
| `recent-failures-full.json`（341 MB）、`history-500.json`、`logs-500.json`、`target-71.json`、`live-logs.json`、`cancel-hydrated.json`、`cancel-tracks.json`、`cancel-canonical.csv`、`failures-canonical.csv`、`model-outcomes.csv`、`target-neighbors.csv`、`history-entries-sample.json` | 都是从归档库 `history-v3-260807.db` 导出的**派生数据**。不可变替代证据 = 该归档 DB（只读、未被本轮改动）+ 已保留的 `incident-analysis/` 脚本；配方写在 README。原始 dump 体积大且随查询口径变化，入库是负债 |
| `status.json`、`status-after-rename.json`、`openapi.json` | 运行实例的瞬时快照；活的真相是运行实例 `GET /openapi.json` 与 `/api/status`（CLAUDE.md 文档路由已声明），快照入库只会变成过期事实 |
| `lint-all.out`、`lint-all.clean.txt`、`lint-fix.out`、`lint-post-merge.out`、`lint-round2/3/4.out`、`backend-isolated.out`、`eslint-sonic-config.json` | 门禁运行日志与调试中间件。结论已由**已提交**的载体承载：spec 的验收证据行、两份评审报告（`docs/tmp/2026-08-08-header-deadline-closeout-review-*.md`）、以及 commit 本身。日志可由重跑同一命令再生 |
| `entry-test-discovery-baseline.feature.json`、`shared-to-feature-baseline.patch` | 合并过程的临时中间件（feature 侧 baseline 副本、共享→feature 的差异冻结）。不可变替代证据 = git 对象本身：副本的 `git hash-object` = `f7c4527b…` = `4a5de5b6:tests/infra/entry-test-discovery-baseline.json`（**逐字节等于已提交 blob**）；patch 两端 blob `882bb2de`／`f7c4527b` 均在库中，可由 `git diff` 完整重建 |
| `accidental-cycle-baseline.patch` | ⚠️ **它 diff 的是 `tests/architecture/circular-deps-baseline.json`（SCC 环基线），不是 entry-discovery baseline**——一次误改该文件后用于还原的冻结件。不可变替代证据：a 侧 blob `73a6a351` 在库中且等于当前树该文件（即**已还原到正确状态**）；b 侧 `75abdbba` 为 `Not a valid object name`（那个错误状态从未被提交）。故该 patch 描述的两端都已被 git 现状取代 |
| `ff-equals-target-poc/`、`ff-equals-target-poc-2/`、`ff-index-target-poc/`（3 个一次性 git 仓库） | 探究「FF 遇 dirty 目标文件」的一次性仓库。**结论已提炼进** `exp/http2-cancel-provenance/README.md` 的「附带发现」；仓库本身无复用价值（三行文件 + 三个提交，重建成本低于维护成本） |

## 边界声明

- 本清单只覆盖 **job `14d4ecd1` 的 tmp 目录**，不含其他 job、不含 `/tmp` 下的 `parallel-test-*` 产物（后者由测试 runner 自行管理，且 16 份 shard JUnit 的结论已交叉验证并写入 spec 与记忆）。
- 「可清理」不等于「已删除」：**清理动作在本清单与接收载体都提交、且独立评审通过之后**才执行，删除时按精确路径逐项删，不用通配符递归删整个目录。

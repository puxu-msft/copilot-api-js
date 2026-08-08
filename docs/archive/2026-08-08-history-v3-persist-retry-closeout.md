# History V3 transient retry 收尾记录

> 状态：实现已完成并合入 `master`；收尾流程加固进行中。实现核验基线：`d59a622ce1afc21587fb692457574ba84d9cabaa`，2026-08-08。本文是一次执行记录，不是活配置权威；当前配置以 [`config.yaml`](../../config.yaml)、[`src/lib/config/schema.ts`](../../src/lib/config/schema.ts) 与 [`src/lib/history/v3/store.ts`](../../src/lib/history/v3/store.ts) 为准。

## 交付结果

- `ea0c0179` 实现并接线 History transient 持久化策略：默认最多 10 次尝试，10ms 起指数退避，单次等待上限 5000ms，单条 entry 墙钟总预算 60000ms，四项均可通过 `history.persist_retry` 配置。
- `10387efe` 将当时的 `master=d3b4ac77` 合入特性分支，解决 `publication.record`／retry 测试与 `session-closeout` verification log 冲突，并保留主线 admission、count/overlay、lossless shutdown 与 PTY 契约。
- `d59a622c` 增加两层默认值 oracle：硬编码断言代码默认 `10/10/5000/60000`，并通过真实 `loadBundledDefaultConfig()` 对账 bundled YAML 与 `DEFAULT_V3_PERSIST_RETRY_CONFIG`。该提交关闭了独立 reviewer 报告的 central acceptance false-green major。
- 用户长期授权已写入项目 `CLAUDE.md`：当前及未来会话可主动运行任意 subagent，同时最多 10 个；该授权不扩张远端发布、破坏性操作或外部写入权限。

## 验收与评审证据

以下数字均为对应命令在所列 commit／同树合并态的点时输出，不是长期测试总数权威：

| 基线 | 命令／范围 | 结果 |
|---|---|---|
| merge tree，提交为 `10387efe` | `bun run typecheck` | exit 0 |
| merge tree，提交为 `10387efe` | `bun run test:backend` | 6631 pass，0 fail，30 skip；runner 另报 7257 executed |
| `d59a622c` 前的 review-fix tree | `bun run test:backend` | 6376 pass，0 fail，30 skip；runner 另报 7259 executed |
| `10387efe` | `bun run test:pty` | 19 pass，0 fail |
| review-fix tree | `bun test tests/config/history-persist-retry-config.unit.test.ts tests/config/bundled-config.unit.test.ts tests/history/v3/transient-retry.it.test.ts` | 16 pass，0 fail |
| `d59a622c`，独立 reviewer 复跑四个相关文件 | reviewer 实测 | 29 pass，0 fail |

独立评审闭环：

1. 冲突、PTY 与 instruction 视角核验 `10387efe` 的两个父提交差异，并实跑 delayed READY、middle SIGUSR2、TUI cooked-mode、one-signal diagnostic 与 child early-exit 路径，结论 0 blocker／0 major。
2. History retry × admission 视角首轮确认 publication、admission、count API 与 60000ms 时间预算均保留，但发现默认值测试会因预置 setter 而 false-green，结论 0 blocker／1 major。
3. `d59a622c` 整改后，原 reviewer 构造代码默认漂移、bundled YAML 漂移及两者同时漂移三类反例，确认互补 oracle 都会变红；复审结论 0 blocker／0 major。
4. 收尾总结经过两轮事实复审；首轮发现 feature 指针陈旧与 bundled YAML oracle 归属错误两项 major，整改后复审结论 0 blocker／0 major。
5. 新增的 job tmp 清理门经独立 `verifier` 做 GREEN 验证，报 2 项 major。Major-2（缺逐项前置）成立并已整改；Major-1（称 manifest 与 tmp 文件错位）经逐项复核为 false-red，不采纳。全部 findings 的证据与处置见 [docs/tmp/2026-08-08-job-tmp-closeout-green-review.md](../tmp/2026-08-08-job-tmp-closeout-green-review.md)。

用户于 2026-08-08 裁决：同一交付合并后不因“刚合并”主动重跑全量测试，沿用合并前／合并态证据；后续改动仍执行自己的交付前门禁。因此 `master=d59a622c` 后未再运行一轮全量测试。

## 已知边界

- `runHistoryWrite("v3-commit")` 与外层 `runHistoryWriteAsync("v3-drain")` 对同一个真实 SQLite transient 失败仍可能重复记录或计数；本轮没有调整日志边界。
- 持续 transient 超过 10 次尝试或 60000ms 总预算后，entry 会记为失败并被放弃；这是有界重试的既定行为。
- 真实 bundled config 测试会打印既有 unknown-key 警告，例如 `history.db_path` 与 `access_log`；目标配置断言通过，这些警告不是本轮引入。

## `$CLAUDE_JOB_DIR/tmp` 清单与处置

盘点根：`/home/xp/.claude/jobs/dddf6825/tmp`。盘点时间：2026-08-08。首次盘点 11 个文件；准备提交本文时新增 `tmp-closeout-project-commit.txt`，清理前复扫门将其打回 disposition，故本清单最终覆盖 12 个文件。在本文提交并验证前不清理源文件。

下列每一项都给出绝对路径、类型、长期价值判断、承接证据、清理前置与最终动作；清理前置逐项可执行，不依赖本节末尾的公共门。

### A 组 · commit message 输入（8 项）

共同属性：类型为一次性 commit message 输入；**长期价值为零**——其全部内容在对应 commit 落库时已被 Git object 逐字保存，tmp 副本是纯重复件。共同最终动作：清理前置通过后删除该绝对路径。

**逐项清理前置**：`git show -s --format=%s <commit>` 的输出与该文件首行**逐字相等**。下表每行的 `<commit>` 与期望 subject 已于 2026-08-08 在 `master` 上逐项实跑核对，全部相等。

| 绝对路径 | commit | 该文件首行内容（= 该 commit 的 subject） |
|---|---|---|
| `/home/xp/.claude/jobs/dddf6825/tmp/history-retry-commit.txt` | `ea0c0179` | `fix(history): strengthen transient persistence retries` |
| `/home/xp/.claude/jobs/dddf6825/tmp/shutdown-pty-commit.txt` | `a61bcbd7` | `test(shutdown): allow loaded PTY fixtures to start` |
| `/home/xp/.claude/jobs/dddf6825/tmp/closeout-verification-commit.txt` | `f6e39031` | `docs: record History retry closeout verification` |
| `/home/xp/.claude/jobs/dddf6825/tmp/merge-master-commit.txt` | `10387efe` | `merge: integrate current master into History retry defaults` |
| `/home/xp/.claude/jobs/dddf6825/tmp/review-fix-commit.txt` | `d59a622c` | `test(history): pin retry policy defaults` |
| `/home/xp/.claude/jobs/dddf6825/tmp/post-merge-test-policy-commit.txt` | `0a88e2c8` | `docs: remember post-merge verification policy` |
| `/home/xp/.claude/jobs/dddf6825/tmp/scope-post-merge-policy-commit.txt` | `f3c7f9be` | `docs: scope post-merge verification policy` |
| `/home/xp/.claude/jobs/dddf6825/tmp/tmp-closeout-project-commit.txt` | `0947b2f0` | `docs: reconcile job temporary artifacts` |

`0a88e2c8` 的策略措辞随后由 `f3c7f9be` 收窄作用域；两个 commit 都保留，本组只核对 message 逐字承接，不涉及策略内容本身。

### B 组 · 结论草稿（1 项）

- **绝对路径**：`/home/xp/.claude/jobs/dddf6825/tmp/final-closeout-draft.md`
- **类型**：收尾总结草稿。
- **长期价值**：其结论有长期价值，草稿载体本身没有——本文已吸收并修正其结论，两轮事实评审发现的 feature 指针陈旧与 bundled YAML oracle 归属错误两项 major 已在本文改正。
- **承接证据**：本文「交付结果」「验收与评审证据」两节；草稿中被推翻的两处不再出现于任何活文档。
- **清理前置**：本文已进入 Git，且草稿中**没有任何结论**只存在于草稿而未出现在本文或其它已提交载体中（逐节比对，2026-08-08 完成）。
- **最终动作**：前置通过后删除该绝对路径。

### C 组 · merge 前冻结快照（3 项）

共同属性：类型为 merge 前工作区冻结快照，用于冲突解析期间比对；**长期价值为零**——其承接对象是 merge commit `10387efe` 及其两个父提交这一不可变 Git 对象，快照本身只是同一状态的可变副本。共同最终动作：清理前置通过后删除该绝对路径。

| 绝对路径 | 内容 | SHA-256 | 逐项清理前置 |
|---|---|---|---|
| `/home/xp/.claude/jobs/dddf6825/tmp/pre-review-cached.patch` | staged binary patch，约 3.4MiB | `7346d989c7175bca0cd57c10c1df8b4b76654296a202a8dad8dc7d8558dc85e7` | `10387efe` 可解析且其两父与 merge 结果均在 `master` 可达 |
| `/home/xp/.claude/jobs/dddf6825/tmp/pre-review-status.txt` | porcelain-v2 状态，约 69KiB | `09c1298380e4be18585e9c6be7d05ad369c95f3eb2d43ded8f72e4c00dbc7c8c` | 同上；冲突解析结果已由 `10387efe` 与两路 merge review 承接 |
| `/home/xp/.claude/jobs/dddf6825/tmp/pre-review-unstaged.patch` | unstaged patch，0 字节 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | 该 digest 是空文件的已知 SHA-256，本身即「冻结时无 unstaged diff」的完整证据，无需外部承接 |

### 清理门

公共门（**在逐项前置之外附加，不替代它们**）：本文必须先进入 Git，且本文内容经独立评审达到 0 blocker／0 major。随后**只删除上述 12 个精确绝对路径**，逐项核对该项自己的清理前置；删除后重新枚举 job tmp。若复扫发现新增文件，必须先补一项完整 disposition（绝对路径、类型、长期价值、承接证据、清理前置、最终动作），禁止用通配删除跳过新文件。

## 收尾流程缺陷与修复方向

旧流程只要求抽象地“inventory temporary state”，项目 `session-closeout` 又只具体列出 plan、实验、memory 与交接。真实失败是：`final-closeout-draft.md`、3.4MiB staged baseline、status 快照和 7 个 commit-message 文件全部留在 job tmp，而收尾仍能走到“可交付”。修复不应只提醒“记得看 tmp”，而应建立最终报告前的结构门：

1. 枚举 `$CLAUDE_JOB_DIR/tmp` 的每个普通文件和符号链接，冻结逐文件 manifest。
2. 每行必须有类型、长期价值判断、项目接收载体或不可变承接证据、最终动作。
3. 项目接收载体先提交并验证；commit-message／patch 等若不入库，必须指向能替代它的 Git object 或已提交证据。
4. 清理只能使用 manifest 中的精确路径；清理后重新枚举，新增项必须回到第 2 步。
5. 最终报告必须声明 tmp 清单数量、已持久化内容、已清理内容与有理由保留内容。

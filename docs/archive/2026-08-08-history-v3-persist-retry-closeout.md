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

用户于 2026-08-08 裁决：同一交付合并后不因“刚合并”主动重跑全量测试，沿用合并前／合并态证据；后续改动仍执行自己的交付前门禁。因此 `master=d59a622c` 后未再运行一轮全量测试。

## 已知边界

- `runHistoryWrite("v3-commit")` 与外层 `runHistoryWriteAsync("v3-drain")` 对同一个真实 SQLite transient 失败仍可能重复记录或计数；本轮没有调整日志边界。
- 持续 transient 超过 10 次尝试或 60000ms 总预算后，entry 会记为失败并被放弃；这是有界重试的既定行为。
- 真实 bundled config 测试会打印既有 unknown-key 警告，例如 `history.db_path` 与 `access_log`；目标配置断言通过，这些警告不是本轮引入。

## `$CLAUDE_JOB_DIR/tmp` 清单与处置

盘点根：`/home/xp/.claude/jobs/dddf6825/tmp`。盘点时间：2026-08-08。首次盘点 11 个文件；准备提交本文时新增 `tmp-closeout-project-commit.txt`，清理前复扫门将其打回 disposition，故本表最终覆盖 12 个文件。在本文提交并验证前不清理源文件。

| tmp 文件 | 类型 | 持久承接／证据 | 最终处置 |
|---|---|---|---|
| `history-retry-commit.txt` | commit message 输入 | Git commit `ea0c0179` 的 subject 为 `fix(history): strengthen transient persistence retries` | 本文提交并复验后删除 tmp 副本 |
| `shutdown-pty-commit.txt` | commit message 输入 | Git commit `a61bcbd7` 的 subject 为 `test(shutdown): allow loaded PTY fixtures to start` | 本文提交并复验后删除 tmp 副本 |
| `closeout-verification-commit.txt` | commit message 输入 | Git commit `f6e39031` 的 subject 为 `docs: record History retry closeout verification` | 本文提交并复验后删除 tmp 副本 |
| `merge-master-commit.txt` | commit message 输入 | Merge commit `10387efe` 的 subject 与两父关系由 Git 保存 | 本文提交并复验后删除 tmp 副本 |
| `review-fix-commit.txt` | commit message 输入 | Git commit `d59a622c` 的 subject 为 `test(history): pin retry policy defaults` | 本文提交并复验后删除 tmp 副本 |
| `post-merge-test-policy-commit.txt` | commit message 输入 | Git commit `0a88e2c8` 保存原始策略措辞；后续由 `f3c7f9be` 收窄作用域 | 本文提交并复验后删除 tmp 副本 |
| `scope-post-merge-policy-commit.txt` | commit message 输入 | Git commit `f3c7f9be` 的 subject 为 `docs: scope post-merge verification policy` | 本文提交并复验后删除 tmp 副本 |
| `tmp-closeout-project-commit.txt` | commit message 输入 | 用于提交本文、项目 `session-closeout` 与 `CLAUDE.md` 的消息；对应 commit 必须在清理前核对 subject 为 `docs: reconcile job temporary artifacts` | 对应 commit 存在且本文复验后删除 tmp 副本 |
| `final-closeout-draft.md` | 收尾总结草稿 | 本文吸收并修正其结论；草稿两轮事实评审的 dispositions 见上节 | 本文提交并复验后删除 tmp 草稿 |
| `pre-review-cached.patch` | merge 前 staged binary patch，约 3.4MiB | SHA-256 `7346d989c7175bca0cd57c10c1df8b4b76654296a202a8dad8dc7d8558dc85e7`；其状态被 merge commit `10387efe`、两个父提交及两路 merge review 承接，不作为长期独立证据 | 本文提交并复验后删除 tmp 重复件 |
| `pre-review-status.txt` | merge 前 porcelain-v2 状态，约 69KiB | SHA-256 `09c1298380e4be18585e9c6be7d05ad369c95f3eb2d43ded8f72e4c00dbc7c8c`；冲突解析结果由 `10387efe` 与 review 结论承接 | 本文提交并复验后删除 tmp 重复件 |
| `pre-review-unstaged.patch` | merge 前 unstaged patch | 0 字节；SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`，证明冻结时无 unstaged diff | 本文提交并复验后删除 tmp 空文件 |

清理门：本文必须先进入 Git、逐条核对上述 commit 可解析且本文内容经独立评审达到 0 blocker／0 major；随后只删除表内 11 个精确路径，并重新枚举 job tmp。若清理前 job tmp 新增文件，必须先补表与 disposition，禁止用通配删除跳过新文件。

## 收尾流程缺陷与修复方向

旧流程只要求抽象地“inventory temporary state”，项目 `session-closeout` 又只具体列出 plan、实验、memory 与交接。真实失败是：`final-closeout-draft.md`、3.4MiB staged baseline、status 快照和 7 个 commit-message 文件全部留在 job tmp，而收尾仍能走到“可交付”。修复不应只提醒“记得看 tmp”，而应建立最终报告前的结构门：

1. 枚举 `$CLAUDE_JOB_DIR/tmp` 的每个普通文件和符号链接，冻结逐文件 manifest。
2. 每行必须有类型、长期价值判断、项目接收载体或不可变承接证据、最终动作。
3. 项目接收载体先提交并验证；commit-message／patch 等若不入库，必须指向能替代它的 Git object 或已提交证据。
4. 清理只能使用 manifest 中的精确路径；清理后重新枚举，新增项必须回到第 2 步。
5. 最终报告必须声明 tmp 清单数量、已持久化内容、已清理内容与有理由保留内容。

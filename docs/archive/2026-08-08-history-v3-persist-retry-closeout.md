# History V3 transient retry 收尾记录

> 状态：实现已完成并合入 `master`；收尾流程加固已完成，job tmp 已按清单清空。实现核验基线：`d59a622ce1afc21587fb692457574ba84d9cabaa`，2026-08-08。本文是一次执行记录，不是活配置权威；当前配置以 [`config.yaml`](../../config.yaml)、[`src/lib/config/schema.ts`](../../src/lib/config/schema.ts) 与 [`src/lib/history/v3/store.ts`](../../src/lib/history/v3/store.ts) 为准。

## 交付结果

- `ea0c0179` 实现并接线 History transient 持久化策略：默认最多 10 次尝试，10ms 起指数退避，单次等待上限 5000ms，单条 entry 墙钟总预算 60000ms，四项均可通过 `history.persist_retry` 配置。
- `10387efe` 将当时的 `master=d3b4ac77` 合入特性分支，解决 `publication.record`／retry 测试与 `session-closeout` verification log 冲突，并保留主线 admission、count/overlay、lossless shutdown 与 PTY 契约。
- `d59a622c` 增加两层默认值 oracle：硬编码断言代码默认 `10/10/5000/60000`，并通过真实 `loadBundledDefaultConfig()` 对账 bundled YAML 与 `DEFAULT_V3_PERSIST_RETRY_CONFIG`。该提交关闭了独立 reviewer 报告的 central acceptance false-green major。
- 用户长期授权已写入项目 `CLAUDE.md`：当前及未来会话可主动运行任意 subagent，同时最多 10 个；该授权不扩张远端发布、破坏性操作或外部写入权限。

## 验收与评审证据

以下每一行都标明它的 tree 身份可否复现。**并非全部可复现**——两行取自未提交的工作树，按 `every-number-carries-scope` 显式标注为不可复现，不以断言语气充当可复跑证据：

| 基线（tree 身份） | 命令／范围 | 结果 |
|---|---|---|
| `10387efe`（可复现） | `bun run typecheck` | exit 0 |
| `10387efe`（可复现） | `bun run test:backend` | 6631 pass，0 fail，30 skip；runner 另报 7257 executed |
| review-fix 工作树，**未提交、tree 身份不可复现**；其内容随后提交为 `d59a622c`，但两者是否逐字节相同已无法事后证明 | `bun run test:backend` | 6376 pass，0 fail，30 skip；runner 另报 7259 executed。**未交叉验证** |
| `10387efe`（可复现） | `bun run test:pty` | 19 pass，0 fail |
| review-fix 工作树，同上，**不可复现** | `bun test tests/config/history-persist-retry-config.unit.test.ts tests/config/bundled-config.unit.test.ts tests/history/v3/transient-retry.it.test.ts` | 16 pass，0 fail。**未交叉验证** |
| `d59a622c`（可复现） | 独立 reviewer 自选的四文件选择器，**原样命令未记录** | reviewer 实测 29 pass，0 fail。**未交叉验证**，复跑需自行重建选择器 |

独立评审闭环：

1. 冲突、PTY 与 instruction 视角核验 `10387efe` 的两个父提交差异，并实跑 delayed READY、middle SIGUSR2、TUI cooked-mode、one-signal diagnostic 与 child early-exit 路径，结论 0 blocker／0 major。
2. History retry × admission 视角首轮确认 publication、admission、count API 与 60000ms 时间预算均保留，但发现默认值测试会因预置 setter 而 false-green，结论 0 blocker／1 major。
3. `d59a622c` 整改后，原 reviewer 构造代码默认漂移、bundled YAML 漂移及两者同时漂移三类反例，确认互补 oracle 都会变红；复审结论 0 blocker／0 major。
4. 收尾总结经过两轮事实复审；首轮发现 feature 指针陈旧与 bundled YAML oracle 归属错误两项 major，整改后复审结论 0 blocker／0 major。
5. 新增的 job tmp 清理门经独立 `verifier` 做 GREEN 验证，报 2 项 major。Major-2（缺逐项前置）成立并已整改；Major-1（称 manifest 与 tmp 文件错位）经逐项复核为 false-red，不采纳。全部 findings 的证据与处置见 [docs/tmp/2026-08-08-job-tmp-closeout-green-review.md](../tmp/2026-08-08-job-tmp-closeout-green-review.md)。
6. Major-1 的分歧交未卷入的第三方仲裁，裁定 8 项绑定全部逐字相等、甲方主张不成立，见 [docs/tmp/2026-08-08-manifest-binding-arbitration.md](../tmp/2026-08-08-manifest-binding-arbitration.md)。
7. 指令文本（项目 `session-closeout` §3b、`CLAUDE.md` ③b、全局 `closing-a-development-session`）与本文经异模型 reviewer 独立评审，报 0 blocker／6 major，**6 项全部采纳并整改**：清理门下沉到清单自身的独立评审之前、全局 skill 的无条件全量复验措辞与项目裁决冲突、三处可被合理化绕过的触发措辞、本文 B 组的假全称断言、验收表口径不足、`长期价值` 与 `intended value` 字段语义分岔。报告见 [docs/tmp/2026-08-08-closeout-instruction-review.md](../tmp/2026-08-08-closeout-instruction-review.md)。

用户于 2026-08-08 裁决：同一交付合并后不因“刚合并”主动重跑全量测试，沿用合并前／合并态证据；后续改动仍执行自己的交付前门禁。因此该交付合并进主线（当时 master tip 为 `d59a622c`）之后未再运行一轮全量测试。此处只描述当时发生了什么，不作为 master 当前位置的断言。

## 仓库与分支状态

- feature 分支 `worktree-history-persist-retry-defaults` 的 worktree 位于 `/home/xp/src/copilot-api-js/.claude/worktrees/history-persist-retry-defaults`，**保留未删除**——用户没有要求删除。
- **未推送任何远端**：本轮全部提交都是本地提交，发布与否是用户的决定。
- 分支与 master 的关系随 peer 工作前进而变化，不在本文冻结具体差距；以 `git log --oneline master..worktree-history-persist-retry-defaults` 的即时输出为准。草稿阶段曾记「`master=d59a622c`、领先 2 个提交、一次 `git merge --ff-only` 即可纳入主线」，该判断**已被 master 的后续前进推翻**（peer 的 nghttp2 header deadline 线推进后不再是 ff-only 情形），作为陈旧结论明确作废，不再作为下一步依据。

## 可复用资产处置

- **已实现**：`CLAUDE.md` 中的 subagent 长期授权与并发上限；同一交付合并后不主动重跑全量测试的项目规则；`session-closeout` §3b 与全局 `closing-a-development-session` 的 job tmp 逐文件对账门。
- **无需新增 agent soul**：本轮没有出现职责边界稳定的新专家角色。
- **无需新增 skill**：现有 `persistence-async-invariants`、`process-lifecycle-shutdown`、`debugging-test-pollution`、`resolving-merge-conflicts` 已覆盖本轮用到的可复用流程；本轮新增的教训落在既有 skill 的加固里，而不是又造一个同义 skill。

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
- **长期价值**：其结论有长期价值，草稿载体本身没有。本文已逐节承接：交付与验证证据见上文两节；仓库状态（worktree 保留、未推送）与可复用资产处置各自成节；「已知边界」三条原样承接。草稿两轮事实评审发现的 feature 指针陈旧与 bundled YAML oracle 归属错误已在本文改正。
- **承接证据**：本文「交付结果」「验收与评审证据」「仓库与分支状态」「可复用资产处置」「已知边界」五节。草稿中已被推翻的结论（`master=d59a622c` 与「一次 ff-only 即可纳入主线」）在「仓库与分支状态」节被显式标为作废，属 superseded 而非遗漏。
- **清理前置**：本文已进入 Git，且草稿中**没有未处置的 durable conclusion**——即逐节比对后，每条结论要么在本文（或其它已提交载体）中有承接，要么被显式判为 transient／superseded 并写明依据。注意这里不是「没有任何结论只存在于草稿」：那个更强的全称断言曾被写进本节，并被独立评审用「仓库状态」与「可复用资产」两节反证推翻，故改为可逐项核对的形式。
- **最终动作**：前置通过后删除该绝对路径。

### C 组 · merge 前冻结快照（3 项）

共同属性：类型为 merge 前工作区冻结快照，用于冲突解析期间比对；**长期价值为零**——其承接对象是 merge commit `10387efe` 及其两个父提交这一不可变 Git 对象，快照本身只是同一状态的可变副本。共同最终动作：清理前置通过后删除该绝对路径。

| 绝对路径 | 内容 | SHA-256 | 逐项清理前置 |
|---|---|---|---|
| `/home/xp/.claude/jobs/dddf6825/tmp/pre-review-cached.patch` | staged binary patch，约 3.4MiB | `7346d989c7175bca0cd57c10c1df8b4b76654296a202a8dad8dc7d8558dc85e7` | `10387efe` 可解析且其两父与 merge 结果均在 `master` 可达 |
| `/home/xp/.claude/jobs/dddf6825/tmp/pre-review-status.txt` | porcelain-v2 状态，约 69KiB | `09c1298380e4be18585e9c6be7d05ad369c95f3eb2d43ded8f72e4c00dbc7c8c` | 同上；冲突解析结果已由 `10387efe` 与两路 merge review 承接 |
| `/home/xp/.claude/jobs/dddf6825/tmp/pre-review-unstaged.patch` | unstaged patch，0 字节 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | 该 digest 是空文件的已知 SHA-256，本身即「冻结时无 unstaged diff」的完整证据，无需外部承接 |

### 清理门

公共门（**在逐项前置之外附加，不替代它们**）：本文必须先进入 Git，且本文内容经独立评审达到 0 blocker／0 major。随后**只删除上述 12 个精确绝对路径**，逐项核对该项自己的清理前置；删除后重新枚举 job tmp。若复扫发现新增文件，必须先补一项完整 disposition（绝对路径、类型、长期价值、承接证据、清理前置、最终动作），**并把更新后的完整清单重新送评审至 0 blocker／0 major**——先前那次评审只覆盖它当时看到的那份清单，不自动延伸到之后变成的样子；禁止用通配删除跳过新文件。

### 执行结果（2026-08-08）

指令文本与本文经三轮独立评审收敛至 0 blocker／0 major（轮次与 findings 见上文「独立评审闭环」第 5–7 条），公共门就此满足。删除前复扫 `/home/xp/.claude/jobs/dddf6825/tmp`，结果与已评审清单**完全一致：12 项、无新增**，故未触发复审重入。随后逐条列出 12 个绝对路径执行删除，未使用任何通配；删除后复扫该目录**为空**。

- **已持久化进项目**：本文（交付、证据、仓库状态、资产处置、已知边界、清单）、[job tmp 清理门 GREEN 验证与处置](../tmp/2026-08-08-job-tmp-closeout-green-review.md)、[绑定争议的第三方仲裁](../tmp/2026-08-08-manifest-binding-arbitration.md)、[指令文本三轮评审与处置](../tmp/2026-08-08-closeout-instruction-review.md)。
- **已删除**：上述 12 个绝对路径，全部为其承接对象（Git object 或本文）的重复件。
- **有理由保留**：无。目录已空。

## 收尾流程缺陷与修复方向

旧流程只要求抽象地“inventory temporary state”，项目 `session-closeout` 又只具体列出 plan、实验、memory 与交接。真实失败是：`final-closeout-draft.md`、3.4MiB staged baseline、status 快照和 7 个 commit-message 文件全部留在 job tmp，而收尾仍能走到“可交付”。修复不应只提醒“记得看 tmp”，而应建立一道结构门，且它的触发点必须覆盖任一收尾触发之后、任何完成／状态／交接报告发出之前、以及会话或阶段结束之前——写成“最终报告前”会被“这只是阶段汇报”一句话绕开：

1. 枚举 `$CLAUDE_JOB_DIR/tmp` 的每个普通文件和符号链接（若另有 harness 提供的 job/session root，取并集），冻结逐文件 manifest。
2. 每行必须有绝对路径、类型、长期价值判断（该内容是否必须活过清理，而非它当初用来做什么）、项目接收载体或不可变承接证据、最终动作、逐项清理前置。
3. 项目接收载体先提交并验证；commit-message／patch 等若不入库，必须指向能替代它的 Git object 或已提交证据。
4. **manifest 本身先过独立评审达到 0 blocker／0 major，才允许执行删除**——删掉唯一一份证据不可逆，其授权不能挂在之后的终稿评审上。
5. 清理只能使用 manifest 中的精确路径；清理后重新枚举，新增项必须回到第 2 步，**并使先前的评审结论作废、整份清单重新过审**——只给新行补 disposition 而不复审，等于让唯一没被外人看过的那一行自己给自己发放删除许可。
6. 最终报告必须声明 tmp 清单数量、已持久化内容、已清理内容与有理由保留内容。

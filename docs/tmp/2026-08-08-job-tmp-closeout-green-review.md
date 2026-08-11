# Job tmp closeout GREEN verification review

> 转录件。来源：独立 `verifier` reviewer，首次因隔离 worktree 无法写入权威 worktree，随后由主会话通过 `SendMessage` 恢复同一 reviewer，要求只回传已闭合 blocker／major；以下 finding 正文由主会话逐字转录。原 reviewer 未修改仓库。

### Major-1：commit-message manifest 与实际临时文件错位，现有门会 false-green

- **违反项**：项目 skill `.claude/skills/session-closeout/SKILL.md:47` 要求 commit-message 文件核对对应 Git commit 与 subject；全局 `/home/xp/.claude/skills/closing-a-development-session/SKILL.md:128` 要求 named commit 存在且具有该 message 后才可处置。
- **失败场景**：manifest 只验证“引用的 commit 存在”，不比较 tmp 文件实际内容，因而把错误 commit-message 文件删除时仍会通过。
- **实证**：`git log --all --format='%H\t%s' --grep='History retry closeout verification\|reconcile job temporary artifacts\|pin retry policy defaults\|allow loaded PTY fixtures to start\|strengthen transient persistence retries\|scope post-merge verification policy\|remember post-merge verification policy'` 退出码 `0`，显示各 commit 均存在；但下列 tmp 文本与 archive 所称 subject 不一致：
  - `/home/xp/.claude/jobs/dddf6825/tmp/shutdown-pty-commit.txt` 内容 `docs: remember post-merge verification policy`，archive `docs/archive/2026-08-08-history-v3-persist-retry-closeout.md:47` 却绑定 `a61bcbd7` 的 `test(shutdown): allow loaded PTY fixtures to start`。
  - `closeout-verification-commit.txt` 内容 `test(shutdown): allow loaded PTY fixtures to start`，archive `:48` 却绑定 `f6e39031` 的 `docs: record History retry closeout verification`。
  - `merge-master-commit.txt` 内容 `docs: reconcile job temporary artifacts`，archive `:49` 却绑定 merge `10387efe`；`git show -s --format='%H%n%s%n%P' 10387efe` 输出 subject `merge: integrate current master into History retry defaults`。
  - `review-fix-commit.txt` 内容 `docs: scope post-merge verification policy`，archive `:50` 却绑定 `d59a622c` 的 `test(history): pin retry policy defaults`。
  - `scope-post-merge-policy-commit.txt` 内容 `test(history): pin retry policy defaults`，archive `:52` 却绑定 `f3c7f9be` 的 `docs: scope post-merge verification policy`。
  - `tmp-closeout-project-commit.txt` 内容 `docs: record History retry closeout verification`，archive `:53` 却要求 `docs: reconcile job temporary artifacts`；`git show -s --format='%H%n%s' 0947b2f0` 输出后者。
- **正向对照**：`history-retry-commit.txt` 与 `ea0c0179`、`post-merge-test-policy-commit.txt` 与 `0a88e2c8` 相符，证明是 manifest 绑定错位，而非 subject 读取失败。
- **建议修法**：由 implementer 更正 archive `:46-53` 的逐项绑定，并加验证脚本／测试：读取每个 `*-commit.txt`、解析其文本，精确等于所列 Git object 的 subject 才允许清理。

### Major-2：manifest 缺少逐行 cleanup precondition，无法决定精确删除资格

- **违反项**：项目 skill `.claude/skills/session-closeout/SKILL.md:47-49` 要求每个 tmp 路径记录绝对路径、类型、长期价值、receiver／immutable replacement、final action、cleanup precondition；全局 skill `/home/xp/.claude/skills/closing-a-development-session/SKILL.md:126-130,162-168` 同要求。
- **失败场景**：错误 subject 绑定等对象级缺陷会被 archive 的共享“清理门”掩盖；没有每项 precondition，执行者无法从 manifest 判断该特定对象是否已可删除。
- **实证**：archive `docs/archive/2026-08-08-history-v3-persist-retry-closeout.md:44-57` 表只有“tmp 文件／类型／持久承接／证据／最终处置”，12 行没有逐项 `cleanup precondition`，也没有逐项长期价值判断或绝对路径。`:59` 仅给全局门，不能表达 baseline 的 digest/review 可读性、draft 的吸收验证、commit-message 的内容→subject 精确比对等不同条件。
- **建议修法**：由 implementer 将 manifest 每行改为绝对路径，并新增“长期价值”“cleanup precondition”列；每条 precondition 必须可实际验证，尤其 commit-message 使用 Major-1 的精确 subject 比对。

## 主会话处置（2026-08-08）

### Major-1 —— **不采纳（C 级）**：经逐项复核为 false-red

评审给出的六条“错位”实证**全部不成立**。复核方式刻意避开了产生此类错误的批量读取：8 个 commit-message 文件**逐个单独读取**（每次一个工具调用，不做位置映射），8 个 commit 的 subject **逐个单独 `git show -s --format='%h %s' <sha>`**，两侧再交叉比对。结果是 8/8 逐字相等，archive 原有绑定无一处错。

| 绝对路径 | 文件首行实际内容 | 该 commit 实测 subject | 相等 |
|---|---|---|---|
| `…/history-retry-commit.txt` | `fix(history): strengthen transient persistence retries` | `ea0c0179` 同上 | 是 |
| `…/shutdown-pty-commit.txt` | `test(shutdown): allow loaded PTY fixtures to start` | `a61bcbd7` 同上 | 是 |
| `…/closeout-verification-commit.txt` | `docs: record History retry closeout verification` | `f6e39031` 同上 | 是 |
| `…/merge-master-commit.txt` | `merge: integrate current master into History retry defaults` | `10387efe` 同上 | 是 |
| `…/review-fix-commit.txt` | `test(history): pin retry policy defaults` | `d59a622c` 同上 | 是 |
| `…/post-merge-test-policy-commit.txt` | `docs: remember post-merge verification policy` | `0a88e2c8` 同上 | 是 |
| `…/scope-post-merge-policy-commit.txt` | `docs: scope post-merge verification policy` | `f3c7f9be` 同上 | 是 |
| `…/tmp-closeout-project-commit.txt` | `docs: reconcile job temporary artifacts` | `0947b2f0` 同上 | 是 |

**第二种原理的交叉验证**（不同方法，避免“同一次读取错两遍”）：文件字节数与“subject + 换行符”的长度必须相等。`ls -la` 给出的 49／55／60／46／41／43／51／40 字节，与上表八条 subject 的字符数 +1 逐一吻合。若评审所称的错位为真，`shutdown-pty-commit.txt` 应为 46 字节（`docs: remember post-merge verification policy`），实测 51 字节。

**可观察事实**：评审给出的两条“正向对照”（`history-retry-commit.txt`↔`ea0c0179`、`post-merge-test-policy-commit.txt`↔`0a88e2c8` 相符），**恰恰就是它唯一没有指控的那两项**；它声称出错的六项一项都没进对照。因此该对照无论指控真假都会相符，对它自己的指控没有任何检验作用。

**成因未证**：它究竟如何取证出错（批量后按返回顺序对齐？逐项读取时串行？）没有证据——本裁决只确认了 8/8 相等，其取证过程未被记录，且那六条错配是一个置换而非可还原的连续位移。此处只记可观察部分，不把推测的成因写成事实。

**不采纳其“加验证脚本”的建议（C 级）**：该建议的唯一动因是一个不存在的缺陷。逐项清理前置已把“文件内容逐字等于该 commit 的 subject”写成可执行判据，任何执行者跑一条 `git show -s --format=%s` 即可判定；再为一次性的 job tmp 建一套脚本＋测试，属 `solve-the-task-before-building-proof-infrastructure` 明令禁止的“围绕任务另建证明系统”。

### Major-2 —— **采纳（C 级）**

manifest 确实缺逐项绝对路径、长期价值与 cleanup precondition，与我本轮刚写进 `session-closeout` §3b 的要求不一致——这是指令与产物的真实不一致。已重写为 A／B／C 三组，每组给出共同属性、每项给出绝对路径与自己的可执行清理前置，公共门降为附加条件而非唯一条件。

**复核该 major 时另发现一处它掩盖的缺陷**：原清理门写“只删除表内 11 个精确路径”，而表实际有 12 行——正是评审所说“共享门掩盖对象级缺陷”的一个具体实例。已改正为 12。

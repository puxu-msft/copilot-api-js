# job tmp 对账评审（视角：事实与授权充分性）

- **评审对象**：`docs/tmp/2026-08-08-header-deadline-job-tmp-reconciliation.md`（清单）+ commit `216a2187`（`exp/http2-cancel-provenance/` 13 文件）。分支 tip `b4a4ac25`。
- **按「允许删除的授权书」强度审**：凡「可清理」项，我都去找它声称的不可变替代证据**本体**，而不是接受措辞。
- **总体 verdict**：**无 blocker、无 major；3 条 minor**。**没有发现「该保留却被判可清理」的项**——这是本次最重要的否定性结论，取证见第 5 节。

## 1. 覆盖完整性：清单 vs 实际枚举

- 我的重新枚举：`find /home/xp/.claude/jobs/14d4ecd1/tmp -maxdepth 1 -mindepth 1` → **42 项**（39 文件 + 3 个 poc 目录）；`du -sh` → **335M**。
- 我把清单五张表逐项拆开数：保留 12（3 探针 + 2 分析脚本 + 7 patch）＋ 可清理 12（派生 dump）＋ 3（瞬时快照）＋ 9（门禁日志/调试件）＋ 3（合并中间件）＋ 3（poc 目录）= **42**。
- **逐项比对结果：漏项 0、多项 0。** 我把实际 42 个条目逐个在清单里找到了归属（含 7 份 `mutate-*.patch` 被合并成一行、3 个 `lint-round*.out` 被合并成一行）。**覆盖是完整的。**

### [minor-1] 清单自报「共 46 项」与任何一种口径都对不上

- **证据**：`find … -maxdepth 1 -mindepth 1 | wc -l` = **42**；清单第 3 行自述的命令 `find … -maxdepth 2 -printf …` 实测输出 **49 行**（含 tmp 自身），`-mindepth 1` 则为 **48**。46 既不是 42 也不是 48/49。
- **影响**：这是授权书里的**数量声明**——复核者按 46 去核对会永远对不平，可能误判「有 4 项没被列出」而阻塞清理，或反过来以为自己数错了而放松核对。
- **实质影响为零**：我逐项比对确认覆盖面本身是全的，错的只是那个总数。
- **建议**：改成「共 42 项（39 文件 + 3 个一次性 git 仓库目录）」，并把枚举命令改成与该数字同口径的 `-maxdepth 1 -mindepth 1`。

## 2. 「可清理」各类的不可变替代证据——逐条实地验

| 类别 | 声称的替代证据 | 我跑的命令 | 输出 | 成立？ |
|---|---|---|---|---|
| 12 份派生 dump（含 341 MB 的 `recent-failures-full.json`） | 归档库 `history-v3-260807.db` + 保留的 `incident-analysis/` 脚本 | `ls -la /home/xp/.local/share/copilot-api/history-v3-260807.db` | 存在，19,641,716,736 字节，mtime `Aug 6 20:26`（**早于**本 job 的 8/8，与「只读、未被本轮改动」自洽） | ✅ |
| 同上 | 脚本里硬编码了该 DB 路径，故配方可跑 | `rg -n 'history-v3-260807' <两个 analyze 脚本>` | 两处 `const dbPath = "/home/xp/.local/share/copilot-api/history-v3-260807.db"` | ✅ 配方与载体对得上 |
| 9 份门禁日志/调试件 | 结论在 spec 验收行 + 两份已提交评审报告 + commit 本身 | `git cat-file -e b4a4ac25:docs/tmp/2026-08-08-header-deadline-closeout-review-criteria.md` | rc=0 | ✅ 载体确实在 git 里 |
| `entry-test-discovery-baseline.feature.json` | 「git 历史本身」 | `git hash-object <tmp 文件>` vs `git rev-parse 4a5de5b6:tests/infra/entry-test-discovery-baseline.json` | 两者同为 `f7c4527b3c09fc40535b5143de6e2c891d1046a9` | ✅ **逐字节等于一个已提交 blob**，这是最强形态的替代证据 |
| `shared-to-feature-baseline.patch` | 同上 | 读 patch 头取两端 blob，`git cat-file -t 882bb2de` / `f7c4527b` | 两端**都是**仓库里已存在的 blob | ✅ 该 patch 可由 `git diff 882bb2de f7c4527b` 完整重建 |
| 3 个 poc 仓库 | 结论已提炼进 exp README「附带发现」 | 读 `216a2187:exp/http2-cancel-provenance/README.md:53-55` | 明写 FF 对 dirty 目标文件的真实前提（工作区**与 index** 都需等于目标），含「只改工作区仍报错」的实测反例 | ✅ 结论确实落盘，且比原始仓库更可用 |
| 3 份瞬时快照 | 活真相是运行实例的 `GET /openapi.json` / `/api/status` | 与 CLAUDE.md 文档路由声明一致（「活的全表面真相 = 运行实例 `GET /openapi.json`」） | — | ✅ 判定与项目既有裁决同向 |

### [minor-2] `accidental-cycle-baseline.patch` 引用了**错误**的替代证据文件

- **位置**：清单「可清理」第 4 行把三件合并为一条理由，落款是「baseline 终值在 `master` 的 `tests/infra/entry-test-discovery-baseline.json`」。
- **实地取证**：`head -12 accidental-cycle-baseline.patch` 显示它的 diff 目标是 **`tests/architecture/circular-deps-baseline.json`**（SCC 环 ratchet 基线），**不是** entry-test-discovery baseline。两者是不同的守卫文件。
- **为什么在授权书里这算问题**：复核者若按清单指名的文件去找这份 patch 的痕迹，在 `entry-test-discovery-baseline.json` 里**永远找不到**，只能二选一——要么误判「替代证据不成立、停手」，要么放松核对直接放行。两条都不是我们想要的。
- **真实结论是安全的（我替它补了取证）**：
  - `git cat-file -t 73a6a351`（patch 的 a 侧＝正确基线）→ `blob`，**在 git 里**；且 `git rev-parse b4a4ac25:tests/architecture/circular-deps-baseline.json` = `73a6a3514d9b…`，即**当前树就是这个正确状态**。
  - `git cat-file -t 75abdbba`（patch 的 b 侧＝误改后的状态）→ `fatal: Not a valid object name`，说明那个错误状态**从未被提交**。
  - 行级复核：`git grep 'upstream-fetch.ts > src/lib/fetch-utils.ts' b4a4ac25 -- <该文件>` rc=1（误加的环**不在**），`git grep 'models/client.ts > src/lib/fetch-utils.ts'` 命中 1（原有的环**还在**）。
- **结论**：该 patch 记录的是一个「已被正确回退、且从未进入历史」的瞬时错误态，删除它无损失——但**清单必须把文件名改对**（改为 `tests/architecture/circular-deps-baseline.json`，终值 blob `73a6a351`），否则这条授权的可核验性是假的。

## 3. 「保留」项的接收载体是否真在 git 里 + 内容是否一致

**用 `git cat-file` / `git ls-tree` 判定，不看 `git status`**（`exp/` 被 `.gitignore:27` 忽略，status 干净不构成证据——清单第 19 行自己也点了这个假绿，判定方法正确）。

- `git ls-tree -r 216a2187 -- exp/http2-cancel-provenance` → **13 个 blob**，与 commit stat 的 13 files 一致，目录结构为 `wire-oracle/`(3) + `incident-analysis/`(2) + `stage1-gate-mutations/`(7) + `README.md`(1)。
- **内容一致性（逐字节）**：`git hash-object` 对 tmp 里 12 个源文件求值，与 `ls-tree` 给出的 blob sha **逐一相等**：
  `cef5c884`(analyze-cancel-hydrated) `f0fd52c5`(analyze-cancel-tracks) `84618d44` `66f2fdd7` `a71bf553` `94553eb7` `a6898503` `4c0532e2` `af21ebc1`(7 份 mutate patch) `cfb91116`(probe-client-abort-race) `10bf2087`(probe-peer-cancel-oracle) `30d75006`(probe-public-peer-cancel)。
  **12/12 完全一致，无一被编辑或截断。** 第 13 个文件 `README.md`（`ff06c4ad`）是新写的说明，不对应 tmp 源文件，属预期。
- **清单点名的核验命令本身有效**：`git cat-file -e <rev>:exp/http2-cancel-provenance/wire-oracle/probe-peer-cancel-oracle.mjs` 在 `216a2187` 及其后代上 rc=0。（清单写的是 `master:…`——**注意**：`216a2187` 目前尚未进 `master`，`git merge-base --is-ancestor 216a2187 master` 会失败；这条命令要等合并后才成立，见 minor-3。）

### [minor-3] 清单给出的核验命令锚在 `master:`，但归档提交此刻还不在 `master`

- **位置**：清单第 19 行「核验方式：`git cat-file -e master:exp/…/probe-peer-cancel-oracle.mjs`」。
- **证据**：`216a2187` 与 `b4a4ac25` 都在 `worktree-nghttp2-header-deadline` 分支上，尚未合入 `master`（本轮全部提交都未 push、未 FF）。此刻照抄该命令会 rc≠0，读者可能误以为归档失败。
- **建议**：把锚点改成 `216a2187:`（不可变、此刻即可复跑），或注明「合并进 master 后用 `master:`，当前用 `216a2187:`」。这是「授权书自带的复核命令必须此刻可跑」的要求。

## 4. exp README 的「它没有证明什么」是否诚实

**诚实，且是本轮质量最高的一份产物。** 三个子目录**各自**带一段否定性声明，且每条都是**具体的边界**而非套话：

- wire-oracle：① **没有重放真实 GHC CANCEL=8**（用的是本地 h2c，产生 INTERNAL_ERROR=2），并主动把 spec §6.2 拆成两条独立判据的理由复述了一遍；② 没覆盖 Bun/Node 全部差异，Node 腿是 capability-gated；③ **没证明 `stream.close()` 在任何位置都不忠实**——只测了四个位置，且明说 `before-respond` 与 post-header 表现不同**正是位置依赖的证据**；④ 没测代理/TLS/真实网络，全是 loopback 明文 h2c。
- incident-analysis：**没证明发起方是 peer**——并指回 F4（同一错误文本无法区分本地与 peer），明说要等阶段 2 结构化 evidence 落地后**回头重新归因**；统计口径限于该归档 DB、非全时段。
- stage1-gate-mutations：**「变异会红 ≠ 判据覆盖完整」**，明确禁止把本目录当覆盖率证据。

**没有发现把窄探针说成全覆盖的地方。** 反向抽查：README:21 声称探针 import 绝对路径、换机器需改路径——`rg -n 'import' probe-client-abort-race.ts` 显示 4 条 `/home/xp/src/copilot-api-js/...` 绝对 import，**声明属实**；README:51 声称 patch 只在 `bea1dfa3` 上下文可靠、更晚的树可能漂移，也是对 exact-patch 机制的正确描述（该提醒防的正是「强推变异」这一已知事故形态）。

## 5. 有没有「该保留却被判为可清理」的项——最危险方向

**逐条走查后：没有。** 我特别盯了四个最容易误杀的候选：

1. **`recent-failures-full.json`（341 MB，占该目录 335M 的绝大部分）** —— 它是 spec §1 问题陈述的原始素材。判为可清理**成立**：产生它的 DB（19.6 GB）与查询脚本都被保留，且 README 明写「原始 dump 故意不入库，可由脚本对同一 DB 重新生成」。**前提已验证存在**，不是空头承诺。
2. **`eslint-sonic-config.json`（79 KB）** —— 它支撑了 `da584116` 把三个非 root-tsconfig 文件改用 `disableTypeChecked` 的决定。判为可清理成立：该决定的**结果**在 `eslint.config.js`（已提交），且 `bun run lint:all` 可随时重跑复核；保留一份 `--print-config` 快照只会随 eslint 升级而过期。
3. **`backend-isolated.out`（598 KB）** —— 结论（0 fail）已在 spec 验收行与 baseline 数字里，且 `test:backend` 可重跑。可清理成立。
4. **3 个 poc 仓库** —— 唯一有长期价值的是那条 FF 前提结论，**已逐字进 README「附带发现」**，且我复核了它的表述包含反例（只改工作区仍被拒），信息没有在提炼中丢失。

**另有一处「宁可多保留」的正确取舍值得记一笔**：7 份 `mutate-*.patch` 本可以按「结论已写进 spec 验收行」清掉，但清单选择保留——理由是 spec 声称「七类 mutation 精确变红」，**没有 patch 就无法复核该声称**。这个取舍方向是对的（可复核性 > 目录整洁）。

## 6. 结论

- **blocker 0 / major 0 / minor 3**：minor-1 总数 46≠42；minor-2 `accidental-cycle-baseline.patch` 的替代证据指错了文件（真实证据我已补齐并验证）；minor-3 复核命令锚在尚未合并的 `master:`。
- **覆盖面完整（42/42）、13 个归档文件逐字节一致、所有替代证据本体我都实地确认存在**（19.6 GB 归档 DB、已提交 blob、已提交评审报告）。
- **未发现该保留却被判可清理的项。** 三条 minor 都是**可核验性**缺陷而非**判定**缺陷：修正后这份清单可以作为删除授权使用；修正前，按它复核会在两处对不平。
- 清单第 34 行「可清理 ≠ 已删除、按精确路径逐项删、不用通配符递归」这条自我约束是正确且必要的，建议原样保留。

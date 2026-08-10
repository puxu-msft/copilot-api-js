# Task 37 收尾：临时证据清单与非文件候选（2026-08-09）

本文件是收尾的**证据处置记录**，不是结论载体——结论各有归属，见下表的「替代证据」列。

## 基线事实（冻结于写作时）

| 项 | 值 |
| --- | --- |
| 本会话交付合并入 master 的提交 | `fe8977c0`（`git merge-base --is-ancestor fe8977c0 master` 通过） |
| 写作时 master | 已由并发会话推进至 `6d212286`（此后 11 个 peer 提交，属正常前进，不触发已验收证据复验） |
| 交付时门禁 | `16 shards · 7726 tests · 7726 pass · 0 fail · 11 skipped`，exit 0，零 crashed shard（测于 `fe8977c0`，树与 master 快进后逐字节相同） |
| job 临时根 | `/home/xp/.claude/jobs/a7c2cc1a/tmp` |
| 冻结成员清单 | `docs/tmp/2026-08-09-task37-closeout-tmp-inventory.md`（排序路径全表，头部带枚举时刻与方法） |
| 成员数 | **427**，两法一致：`os.walk`（含指向目录的符号链接）与 `find "$R" \( -type f -o -type l \)` 同为 427 |

⚠️ **本清单的第一版写的是 424，那个数是错的，值得记下来它怎么错的。** 三处：
1. **它是写作时快照，而同一个 job 随后还在往那个目录写**——我自己写的 commit-message 文件就把它撑到了 425。**裸总数不能宣称「全覆盖」**，必须锚到一份冻结的成员集合；本文件现在锚到上表那份排序清单，分类表逐类对账到 427。
2. **分类表混了两个 selector**：扩展名计数取自 `-maxdepth 1`（顶层），类计数取自全树，于是各行之和既不等于顶层数也不等于全树数。
3. **第一次冻结用 `os.walk` 只遍历 `filenames`，漏掉 2 个指向目录的符号链接**（`os.walk` 把它们归进 `dirnames`），得 425 而 `find` 得 427。**这正是「两种方法交叉验证」该抓的东西**——第一次跑就 DISAGREE，改对方法后才 AGREE。

⚠️ 另一条枚举陷阱：交叉核对必须用 `fd -H -I`。**不带 `-I` 的 `fd` 会遵守 `.gitignore` 而少报**，而本仓多数 job 产物落在被忽略路径下——少报的恰恰是没人复核过的那些。

**job 目录在 job 存活期间保持可写，此后新增是预期内的**，由下表的类规则覆盖，不由这个数覆盖。

## 文件处置（按类，逐类对账到冻结集合的 427 行）

| 类 | 数量 | 长期价值 | 替代证据 / 接收方 | 处置 |
| --- | --- | --- | --- | --- |
| 命令输出 / 门禁日志（`.txt` `.log`） | 237 | 无。被引用的数字均已逐条抄进提交信息与评审报告 | 提交信息 `3a6439ea`／`b8ab9dbb`／`9325ea4d`／`fefb0951`／`e19351e4`／`a72a8e83` 的 Gate 段；`docs/tmp/2026-08-09-task37-seam-review-dispositions.md` | 保留至 job 过期（不主动删） |
| JUnit / 结构化产物（`.xml` `.json`） | 62 | 无。skip 多重集核对结论已落盘 | 本文件 N2／N3 行 + `tests/infra/entry-test-discovery-baseline.json` | 同上 |
| 临时 TS 探针（`.ts`） | 53 | **部分有**：本轮两个分类探针已提交进仓库 | `exp/task37-anthropic-error-boundary/{probe-classify,probe-roundtrip}.ts` + README | 已持久化，副本保留至过期 |
| 一次性编辑 / 整改脚本（`.py`） | 52 | 无。每个都是对某仓库文件做一次文本编辑，结果已提交 | 对应 commit 即结果 | 同上 |
| 变异 / 临时 patch | 10 | 无。每个变异的「符号 → 判据 → 失败形态」均已记录 | dispositions 的变异正控表 + `fefb0951`／`a72a8e83` 提交信息 | 同上 |
| 探针 / 分析脚本（`.py`） | 7 | **部分有**，见下「唯一产出方」节 | 见该节 | 同上 |
| 报告草稿（`.md`） | 2 | 无。已蒸馏进正式报告 | `docs/tmp/2026-08-09-task37-seam-review-*.md` | 同上 |
| 其他 | 2 | 无 | —— | 同上 |
| 符号链接（2 条，均指向 `node_modules`） | 2 | 无。其一指向 `.claude/worktrees/placeholder/node_modules`（本 job 早期 Task 9 阶段的树，仍存在） | —— | 同上；**不删**，删链接对目标无影响但无收益 |

**合计 427，与冻结清单成员数相等**（`recompute-classes.py` 机械对账，OK）。

**不执行删除。** 理由是**可核验的门，不是价值判断**（第一版写的「边际成本为零、边际风险为负」是后者，已撤）：① harness 在 job 过期时自行回收该目录，`closing-a-development-session` 明确允许在「每个对象均有 disposition」的前提下保留；② 删除不可逆，而本轮 review 的非文件双向对账**曾经非空**（见 N8–N13），按同一 skill 必须失败关闭、保留全部对象。冻结集合之后新增的对象（写作时已到 429）由上表的类规则给出「保留至过期」的动作；**若将来改为主动删除，类规则不够——必须重新逐路径冻结、分类并复评。**

## 「唯一产出方」审查（skill 明确点名的高危类）

逐个检查是否存在「结论只在此、仓库无载体」的文件：

| 文件 | 它产出了什么 | 载体 | 判定 |
| --- | --- | --- | --- |
| `attrib-duplicate-error.py` | 归属判定：重复终态由 adapter `case "error"` 引入 | `fefb0951` 提交信息的 before／after 帧序列表 | 已有载体 |
| `halfblock-probe.py` | 归属判定：半块泄漏由 D5 分支引入 | `9325ea4d` 提交信息 + `docs/todo/deferred-backlog.md` 的 A／B 实测行 | 已有载体 |
| `show-types.py` | 观测客户端实收帧类型序列的手法 | 手法已内化进 `tests/pipeline/i9-h2-buffered-probe.http.test.ts` 的 `event: error` 计数断言 | 已有载体 |
| `register-skip.py`／`register-suite-skip.py`／`sort-skips.py`／`check-skips.py` | **基线维护的两条操作事实** | ⚠️ **原先无载体**——已于本次收尾补进 backlog，见 N2／N3 | 已修复 |
| `m1`–`m5`／`hb.patch` | 五次变异的精确 diff | 变异正控表已记「符号 → 判据 → 失败形态」，达到可重建粒度 | 已有载体 |

## 非文件候选（Stage `discover_nonfile_candidates`）

文件清单结构上看不见的知识。**每行标 provisional，处置与文件行同权。**

**事件源与范围（第一版没写，是 RR4 判 MAJOR 的直接原因）**：本 job 的 transcript 实际位于 `/home/xp/.claude/projects/-home-xp-src-copilot-api-js--claude-worktrees-task37-closeout/a7c2cc1a-1103-4c54-8ae1-e2837bda4112.jsonl`。⚠️ **transcript 路径随会话所在 worktree 变化**——第一版我给评审的是 worktree 前缀之前的旧路径，那个文件不存在，评审自己定位到了真路径。

**枚举范围钉死为 JSONL 第 1–15108 行**（评审独立枚举所依据的冻结范围）。⚠️ **不再声称「覆盖整个 session」**：写作期间该 transcript 已增长到 15419 行，而收尾本身仍在产生事件，「整个 session」是一个写下即过期的断言。15108 行之后的事件由本次收尾的评审往返构成，其结论已在本文件与评审报告里。

**本 job 横跨两个阶段**：前半是 Task 9（History V3 证据存储），后半是 Task 37（接缝复审）。下表覆盖上述冻结范围内的两个阶段。

| # | 类 | 内容 | 来源事件 | 如何复现 | 载体 |
| --- | --- | --- | --- | --- | --- |
| N1 | 3 修正的解析／作用域错误 | **在变异之后用 `git diff` 导出恢复 patch，对未跟踪文件得到空 patch，恢复因此没有发生**。它**失败关闭、不是静默失效**：`git apply --reverse --check` 对空输入报 `No valid patches in input` 并退出 128，`&&` 链就此停住、`RESTORED` 未打印——但变异仍在树上，须手工撤销 | 对 `src/lib/anthropic/wire-frame-type.ts`（当时新建、未 `git add`）做正控 | 新建文件 → 编辑 → `git diff -- <file>` 得空 → `git apply --reverse --check` 该空 patch | skill `positive-control-your-tests` 步骤 1（本次补） |
| N2 | 3／6 | **discovery 基线 `allowed_skipped` 必须按 `skipSortKey`（NUL 连接的 identity 字段）逐字节全序**；追加到末尾会以 `allowed_skipped are not unique bytewise sorted` 失败，而**报错的测试名是「tracks the current backend discovery population」**（一条 files 断言），真正的 throw 来自 `parseDiscoveryBaseline`，极易误判 | 注册 gated skip 时踩中 | 往 `allowed_skipped` 末尾追加一条后跑该守卫 | backlog（本次补） |
| N3 | 3／6 | **一个被 `describe.skip` 的套件产出两条 skip identity**：具名那条 + `name:"(unnamed)"` 的套件级那条。只登记具名的会留下潜伏的多重集不匹配 | 用真实运行的 `skipped-multiset.json` 核对时发现 | 跑 `parallel-test` 后读 artifacts 的 `skipped-multiset.json` | backlog（本次补） |
| N4 | 6 运行时探针 | `errorShapingEnabled` 经 `setStateForTests` 在**全应用 HTTP 测试里确实生效**（关闭态可观测到 raw error 帧原样透传） | 参数化 `i9-h2-buffered-probe` 时实测（JSONL 附近） | 见该测试的 `describe.each([true, false])` | **无需补载体**——见下 |
| N5 | 1 已否决路线 | 在 `mergeCandidateResponseOpts` 里 OR-组合 `commitBoundaries`（修法①）——会让 handler 层 JSON classifier 复活，违反 Task 3 冻结契约「adapter.classify 是唯一 wire classifier」 | 修 D2 时的两个候选 | —— | dispositions 已记 |
| N6 | 1 已否决路线 | `test.failing` 取代 `describe.skip`——自解除更优，但 JUnit／基线口径未验证、本仓无先例 | 第三轮评审建议 | —— | backlog 已记 |
| N7 | 2 已证伪的因果 | 「`discardOpen` 保证半块不会送达客户端」——错。`discard-open-unit` outcome 在 `src/` 零消费者，它只清 grammar 自己的累积 | `b8ab9dbb` 提交信息写下该断言，第三轮评审证伪 | `grep -rn 'discard-open-unit' src/` | `grammar.ts` 注释 + dispositions |
| **N8** | 1 已否决路线 + 2 已证伪 | **D5 整条路线被撤回**：让 `acceptTerminal` 对 `failed` 终态发出终态而非协议错误，重试确实停了，**但引入半块泄漏 + 双终态**。这是「路线」级候选，N7 只记了它其中一条错误因果，替代不了它 | JSONL 13720–14077 | backlog 那条 A／B（分支开：1 次上游调用 + `content_block_delta("mid-block")` 上线；撤回态：4 次调用、该 delta 0 次） | `docs/todo/deferred-backlog.md`「已被实测否掉的直接修法」 |
| **N9** | 3 无失败信号的判据错误 | **把控制点参数化到一个结构上无鉴别力的形状**（「已提交块 + error」——块已提交后重试闸门本就关闭，`upstreamCalls` 恒为 1），结果是**两格绿而非一格更强的判据**。我在同一轮里刚写下这个形状判别不了任何 error 分类机制，随后又把新控制点放了进去。**可执行判据**：给一条判据加参数之前，先问「这个形状在**任一**参数取值下能不能被目标变异打红」；答不出就先做变异对照，别先加参数 | JSONL 13668／14741 | 移除 adapter 的 event 行回落 → 该测试两格仍绿；移到「无前置内容」形状后才红 | 本表（自足）+ **建议**加入 skill `catching-false-green-tests`，已向用户提出、待裁决 |
| **N10** | 6 运行时探针 | **真实入口探针实测客户端收到 `["message_start","error","error"]`**（两个终态），这是 D6 的直接证据、也是把判据从 `toContain` 改成数条数的理由 | JSONL 14441 | 见 `tests/pipeline/i9-h2-buffered-probe.http.test.ts` 的 `event: error` 计数断言 | `fefb0951` 提交信息 + 该测试 |
| **N11** | 3 无失败信号的判据错误 | **首版性能判据「测了个空」**——没跑迁移，判据从未触达目标路径，因此无论实现对错都绿 | JSONL 7303（Task 9） | 把该判据指向一个**未执行迁移**的库，观察它仍然通过；正样本是先跑迁移再测，两者应给出不同结论 | 本表（自足） |
| **N12** | 2 已证伪的因果 | `stripAnsi` 漏删 ESC 的根因假设被探针证伪 | JSONL 5966（Task 9） | 对含裸 ESC 的样本直接调 `stripAnsi` 并比对字节，而不是从上层现象推断 | 本表（自足） |
| **N13a** | 2 已证伪的因果 | 「negotiation flaky 已闭合」被证伪——闭合结论下得过早 | JSONL 6027（Task 9） | 对该用例连跑 10–25 次（本仓 flaky 判定的既有做法），单次绿不构成闭合 | 本表（自足） |
| **N13b** | 2 已证伪的因果 | `createSerializedAsyncFn` 的行为假设被证伪 | JSONL 6058（Task 9） | 直接对该原语写最小探针断言其串行化语义，别从调用方现象反推 | 本表（自足） |
| **N13c** | 3 修正的作用域错误 | 测试 fixture 对 `commitV3HistoryEntry` 的 API 假设不成立 | JSONL 1471（Task 9） | 读该函数当前签名与返回值，再对照 fixture 的调用形状 | 本表（自足） |
| **N14** | 3 无失败信号的判据错误 | **F2 正控被误判为「缺失」，实际是邻接防线在结构上不可达**——即该正控无法构造，不是忘了写 | JSONL 6603（Task 9） | 尝试为该防线构造正样本；构造不出本身就是结论，须写明「不可达」而非「待补」 | 本表（自足） |
| **N15** | 1 已放弃路线 | **放弃用正则判定 DML，改为冻结命中集合** | JSONL 7664（Task 9） | 正则分不清「真依赖」与「描述该依赖的文字」，这是 user-rule `freeze-hit-set-not-zero-hits` 的实例 | 本表 + user-rule `60-evidence-and-criteria` |
| **N16** | 3 修正的作用域错误 + 2 已证伪 | **锚点标反**（把某数字锚到一个 docs-only 提交），以及**「充分性」主张四次换措辞回流**——同一个被否掉的断言换个说法又出现 | JSONL 10253／10333（Task 9） | 锚点：`git show --stat <锚定的 commit>` 看它是否真含该数字的来源改动。回流：对已否决的断言登记其**语义**而非措辞，复审时按语义查 | 本表（自足） |
| **N17** | 1 已撤回的越权动作 | **我曾用一条收尾注解擅自缩小一份冻结 RFC 的验收含义，随后撤回**并改为登记为待裁决的 open question | JSONL 10848／10907（Task 9） | 判据：改动是否降低了冻结文档的验收强度；若是，属推翻既有裁决，须交所有者 | 本表 + user-rule `check-existing-decisions-before-changing-behavior` |
| **N18** | 2 已证伪 + 1 已否决路线 | **D1「Task 4 提前落地」是归属误判**（由未卷入的裁决者裁定撤销）；**且同一评审给的 D2 修法方向是反的**——它建议删掉 handler 的外层谓词，那会把语义偏差固化 | JSONL 12663（Task 37） | 归属：查 Task 4 四项交付物是否存在 + 被引基础设施的引入日期 vs 计划日期。修法方向：比较被删谓词与替代投影的**边界集合**是否相等 | `docs/tmp/2026-08-09-task37-d1-arbitration.md` + dispositions |

**N11–N18 的载体说明**：这几条以**本文件自身**为仓库 carrier（已提交），不另建文档。评审确认该处置可接受；此前「不追溯补载体 + 无复现方式」的写法不可接受，已按要求补齐每行的复现方式并把原 N13 拆成三行。

## 待补载体（本次收尾产生的动作项）

- **N1** → 归属 user-level skill `positive-control-your-tests`（它拥有「Restoring the mutation without destroying real work」一节）。**已写入该节步骤 1**，作为「patch 来源」这条正令的失败形态。首版措辞含两处缺陷、经独立评审指出后已改：① 写过「for a tracked file it happens to work」——那等于给「事后从 diff 导出」这条捷径发一张 tracked 文件通行证，与步骤 1 的白名单正令竞争，已收敛为无例外表述；② 写过一句 peer edit 会被「静默扩进」的全称因果，本次事故并未实测该路径，已改为条件化命题。**该改动仍在复评中，未定稿。**

## 查过但判定**不需要**改载体的（记下来，免得下次重查）

- **N4**：初判为「限定既有记忆的适用面」，**复核后撤回**。记忆 `reference-config-yaml-overwrites-setstatefortests-per-request` 的判据本来就不是「一律空操作」，而是「取决于生效 config 里有没有显式写那个键」。
    **真正的独立依据是代码路径**：`tests/pipeline/i9-h2-buffered-probe.http.test.ts` 用默认 `createFullTestApp()`、且请求 payload 没有 `system`，按 canonical skill `test-isolation` 的调用点表，这条 harness／route 在目标消费之前不会触发 `applyConfigToState()`，所以 `setStateForTests({ errorShapingEnabled })` 存活。
    ⚠️ **仓库根 `config.yaml` 无命中只是辅助证据，不能单独裁决**——`test-isolation` 明确警告仓库根那一份不代表 bundled + user 合成后的生效 config。第一版把它当主要理由写了，是方法上的错；照那样泛化会在别的 suite 漏掉 sandbox user config 与 synthetic bundled config。结论仍是**印证实例、不是订正，不改那条记忆**。


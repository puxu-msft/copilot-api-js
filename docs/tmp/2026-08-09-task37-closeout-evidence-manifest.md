# Task 37 收尾：临时证据清单与非文件候选（2026-08-09）

本文件是收尾的**证据处置记录**，不是结论载体——结论各有归属，见下表的「替代证据」列。

## 基线事实（冻结于写作时）

| 项 | 值 |
| --- | --- |
| 本会话交付合并入 master 的提交 | `fe8977c0`（`git merge-base --is-ancestor fe8977c0 master` 通过） |
| 写作时 master | 已由并发会话推进至 `6d212286`（此后 11 个 peer 提交，属正常前进，不触发已验收证据复验） |
| 交付时门禁 | `16 shards · 7726 tests · 7726 pass · 0 fail · 11 skipped`，exit 0，零 crashed shard（测于 `fe8977c0`，树与 master 快进后逐字节相同） |
| job 临时根 | `/home/xp/.claude/jobs/a7c2cc1a/tmp` |
| 枚举计数 | **424** 个文件/符号链接，由 `find "$R" \( -type f -o -type l \) \| wc -l` 产出；交叉核对 `fd -H -I --type f --type l \| wc -l` 同为 424；顶层条目 354 |

⚠️ 交叉核对用的是 `fd -H -I`。**不带 `-I` 的 `fd` 会遵守 `.gitignore` 而少报**，而本仓多数 job 产物落在被忽略路径下——少报的恰恰是没人复核过的那些。

## 文件处置（按类，424 行全覆盖）

| 类 | 数量 | 长期价值 | 替代证据 / 接收方 | 处置 |
| --- | --- | --- | --- | --- |
| 命令输出 / 门禁日志（`.txt` `.log`） | 235 | 无。被引用的数字均已逐条抄进提交信息与评审报告 | 提交信息 `3a6439ea`／`b8ab9dbb`／`9325ea4d`／`fefb0951`／`e19351e4`／`a72a8e83` 的 Gate 段；`docs/tmp/2026-08-09-task37-seam-review-dispositions.md` | 保留至 job 过期（不主动删） |
| JUnit / 结构化产物（`.xml` `.json`） | 62 | 无。skip 多重集核对结论已落盘 | 本文件 N2／N3 行 + `tests/infra/entry-test-discovery-baseline.json` | 同上 |
| 临时 TS 探针（`.ts`） | 53 | **部分有**：本轮两个分类探针已提交进仓库 | `exp/task37-anthropic-error-boundary/{probe-classify,probe-roundtrip}.ts` + README | 已持久化，副本保留至过期 |
| 一次性编辑 / 整改脚本（`.py`） | 43 | 无。每个都是对某仓库文件做一次文本编辑，结果已提交 | 对应 commit 即结果 | 同上 |
| 探针 / 分析脚本（`.py`） | 15 | **部分有**，见下「唯一产出方」节 | 见该节 | 同上 |
| 变异 / 临时 patch | 10 | 无。每个变异的「符号 → 判据 → 失败形态」均已记录 | dispositions 的变异正控表 + `fefb0951`／`a72a8e83` 提交信息 | 同上 |
| 报告草稿（`.md`） | 2 | 无。已蒸馏进正式报告 | `docs/tmp/2026-08-09-task37-seam-review-*.md` | 同上 |
| 其他 | 4 | 无 | —— | 同上 |

**不执行删除。** 424 个路径全部有处置，交由 harness 在 job 过期时回收。理由：删除不可逆，而这些文件的**结论**已全部有仓库载体，保留它们的边际成本为零、边际风险为负。

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

| # | 类 | 内容 | 来源事件 | 如何复现 | 载体 |
| --- | --- | --- | --- | --- | --- |
| N1 | 3 修正的解析／作用域错误 | **`git diff` 对未跟踪文件产出为空，因此「冻结 patch → 反向应用」的变异复原协议对新建文件静默失效**——变异留在原地，只有 `git apply` 报 `No valid patches in input` 才暴露 | 对 `src/lib/anthropic/wire-frame-type.ts`（当时未跟踪）做正控 | 新建文件 → 编辑 → `git diff -- <file>` 得空 | ⚠️ 见「待补载体」 |
| N2 | 3／6 | **discovery 基线 `allowed_skipped` 必须按 `skipSortKey`（NUL 连接的 identity 字段）逐字节全序**；追加到末尾会以 `allowed_skipped are not unique bytewise sorted` 失败，而**报错的测试名是「tracks the current backend discovery population」**（一条 files 断言），真正的 throw 来自 `parseDiscoveryBaseline`，极易误判 | 注册 gated skip 时踩中 | 往 `allowed_skipped` 末尾追加一条后跑该守卫 | backlog（本次补） |
| N3 | 3／6 | **一个被 `describe.skip` 的套件产出两条 skip identity**：具名那条 + `name:"(unnamed)"` 的套件级那条。只登记具名的会留下潜伏的多重集不匹配 | 用真实运行的 `skipped-multiset.json` 核对时发现 | 跑 `parallel-test` 后读 artifacts 的 `skipped-multiset.json` | backlog（本次补） |
| N4 | 6 运行时探针 | `errorShapingEnabled` 经 `setStateForTests` 在**全应用 HTTP 测试里确实生效**（关闭态可观测到 raw error 帧原样透传） | 参数化 `i9-h2-buffered-probe` 时实测 | 见该测试的 `describe.each([true, false])` | **无需补载体**——见下 |
| N5 | 1 已否决路线 | 在 `mergeCandidateResponseOpts` 里 OR-组合 `commitBoundaries`（修法①）——会让 handler 层 JSON classifier 复活，违反 Task 3 冻结契约「adapter.classify 是唯一 wire classifier」 | 修 D2 时的两个候选 | —— | dispositions 已记 |
| N6 | 1 已否决路线 | `test.failing` 取代 `describe.skip`——自解除更优，但 JUnit／基线口径未验证、本仓无先例 | 第三轮评审建议 | —— | backlog 已记 |
| N7 | 2 已证伪的因果 | 「`discardOpen` 保证半块不会送达客户端」——错。`discard-open-unit` outcome 在 `src/` 零消费者，它只清 grammar 自己的累积 | `b8ab9dbb` 提交信息写下该断言，第三轮评审证伪 | `grep -rn 'discard-open-unit' src/` | `grammar.ts` 注释 + dispositions |

## 待补载体（本次收尾产生的动作项）

- **N1** → 归属 user-level skill `positive-control-your-tests`（它拥有「Restoring the mutation without destroying real work」一节，而该节的协议对未跟踪文件不成立）。属指令类文本，须经独立评审后安装。

## 查过但判定**不需要**改载体的（记下来，免得下次重查）

- **N4**：初判为「限定既有记忆的适用面」，**复核后撤回**。记忆 `reference-config-yaml-overwrites-setstatefortests-per-request` 的判据本来就不是「一律空操作」，而是「取决于生效 `config.yaml` 有没有显式写那个键」——它的原文写着「同一个 policy 对象里一半字段听测试、一半字段听配置文件⋯⋯因为 `config.yaml` 没写那个键」。实测 `grep -n 'error_shaping\|errorShaping' config.yaml` 无命中，所以 `errorShapingEnabled` 存活**正是该机制的预测结果**。这是印证实例，不是订正，**不改那条记忆**。


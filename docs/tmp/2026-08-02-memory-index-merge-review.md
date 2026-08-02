# 记忆索引合并压缩审查

## 评审范围与总体结论

- **评审范围**：仅审查 `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md` 相对 `HEAD` 的未提交改动；未评价同目录其它并发会话改动，也未修改被审文件。
- **已读取/执行的证据**：完整 diff；HEAD/current 索引链接集合；所有 21 条多链接合并行及其 52 个现存链接目标正文；三个孤儿正文；`docs/DESIGN.md`、`docs/API.md`、相关 spec/plan/handover；`git show`、`git log`、`merge-base --is-ancestor`、全索引断链/孤儿枚举。
- **总体 verdict**：**修复 major 后可进入下一阶段，不可直接提交**。
- **Blocker 数量**：0。
- **发现计数**：Major 4，Minor 2。最严重问题不是指针丢失，而是合并行引入了多条已过期状态断言，并让 4 个原有动作/症状钩子不可检索。

## 命题 1：零指针丢失

**结论：成立。未发现旧指针丢失。**

独立执行用户指定的集合差命令，`comm -23` 输出为空。计数结果为：HEAD 唯一 `.md` 链接 156 个，current 157 个；唯一新增链接为 `reference-subagent-transcript-5mib-gate-blocks-resume.md`。

```text
comm -23 ...
# 无输出
HEAD unique links: 156
CURRENT unique links: 157
added links:
reference-subagent-transcript-5mib-gate-blocks-resume.md
```

这证明“零旧指针丢失”，但不证明链接目标存在；命题 5 的两个既有断链仍然存在。

## 命题 2：零话题丢失

**结论：不成立。至少 4 个原有触发症状或动作内核在新版中不可检索，另有若干合并项虽保住标题但动作内核弱化。**

逐条把 HEAD 中所有被删除/改写的 stub 映射到 current 中包含同链接的合并行，并核对原钩子的承重短语。以下 4 个明确丢失：

1. **Codex/Responses tier-1 的“下游保活”动作轴丢失**。HEAD 第 166 行含“关闭码1000+guardCallback+下游保活+opt-in buffered”，current `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:133` 只剩关闭码、guard、buffered 与 runtime split，不再出现“下游保活”。这会让“Responses 下游长静默/300s 客户端 idle”类症状无法由该索引行触发。
2. **GHC tool-search 的 `default-allow` 语义丢失**。HEAD 第 170 行含 `tool-search default-allow`，current `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:145` 只写 `tool-search`。源文件 `/home/xp/src/copilot-api-js/docs/memory/project-ghc-feature-alignment-landed.md:9-12` 明确该教训是“手动列表 → default-allow”；删掉后只剩功能名，不再携带动作内核。
3. **cell-assembly 的二维键 `(clientFormat×targetEndpoint)` 丢失**。HEAD 第 161 行明确写 `(clientFormat×targetEndpoint) 双穷尽 Record`，current `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:140` 只写“codec 双穷尽 Record”。源文件 `/home/xp/src/copilot-api-js/docs/memory/project-inbound-outbound-cell-assembly-refactor.md:10-12,38` 的根因正是两轴对象模型错配；不保留两轴名，会削弱“漏填某个入站×出站 cell”时的触发能力。
4. **reasoning 透传的“标签封装签名”动作丢失**。HEAD 第 160 行写 `summary:auto/标签封装签名 round-trip`，current `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:140` 只剩 `summary:auto 签名 round-trip`。源文件 `/home/xp/src/copilot-api-js/docs/memory/project-reasoning-passthrough-synthetic-thinking.md:21-26` 的承重机制是带无歧义前缀的标签封装；仅“签名 round-trip”无法触发“如何区分合成 signature 与真 Claude signature”的动作。

独立检索证据：

```text
HEAD: 下游保活 / default-allow / clientFormat×targetEndpoint / 标签封装签名 均命中
CURRENT: 四个短语均 0 命中
```

**[Major] `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:133,140,145` — 合并后 4 个承重触发词消失。** 修复时应把上述动作内核直接恢复进对应合并行；不能只依赖链接标题，因为索引开头 `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:3-5` 明确要求每行自身携带“症状词 + 防漏动作内核”。

其余被合并的 HEAD stub 均仍能在 current 行中找到对应话题和至少一个动作内核，例如持久化三件套、Umzug partial-DDL、backfill `SELECT *`、UI 双门、synthetic marker、日志 ground truth、eslint 四坑、CODEX_HOME、History 三件、翻译矩阵等。它们并非全部同等强，但没有再发现可证实的“原话题完全不可检索”。

## 命题 3：多链接合并行的钩子与文件配对

**结论：内容配对大体正确，但有 4 条 Major 状态错配；另有 1 条 Minor 归属不完整。**

共识别 21 条多链接行，解析出 52 个现存链接目标并逐个读正文；`/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:141` 的 `project-unknown-endpoint-logging.md` 除外，因为目标不存在，按命题 5 处理。方法论区的合并配对均正确：

- `:11` 三个链接分别对应 async 持久化不变量、settle 前冻结、committed outcome 记录；正文证据为各文件第 8-9 行。
- `:12-17` 的 telemetry、Umzug/boundary-strip、backfill、large-refactor、empirical verification、frontend test 配对均与各源文件 `description` 和 `How to apply` 一致。
- `:24,34,53,61` 的 richest-data-flow、日志 ground truth、eslint 四坑、CODEX_HOME/lockfile 配对正确。
- `:130,131,134,137,140,144-146` 的机制描述与目标正文基本一致。

但以下状态或机制归属错误：

**[Major] `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:131` — “History 搜索 sidecar 待合并”已过期。** 当前权威 `/home/xp/src/copilot-api-js/docs/DESIGN.md:94` 明确“search 移出主进程全部 Phase 0-4 已合并 2026-07-21”；生产入口新增 commit `30a483df` 与 systemd commit `4950e46f` 都是 master 祖先。应改为已 landed/master，不应继续写“待合并”。

**[Major] `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:133` — “Responses buffered-merge 待合并”已过期。** `/home/xp/src/copilot-api-js/docs/DESIGN.md:81` 标为 `[done] ... landed master`；生产 reducer 新增 commit `8e0376d4` 是 master 祖先。应改为 landed。该行末尾的 `opt-in buffered(默认 OFF)` 属于 tier-1 原始 buffered retry 的历史描述，而同一行前半的 buffered-merge 在当前 Responses 默认 buffered 路径上生效；两者挤在一起容易把“哪个 OFF”张冠李戴，至少应明确 `默认 OFF` 指 tier-1 原始 buffered retry，而非 buffered-merge 两旋钮。

**[Major] `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:136` — “上游 hook 中间件（spec v2 待审）”已过期且与当前架构不符。** 链接目标 `/home/xp/src/copilot-api-js/docs/memory/project-upstream-hook-middleware.md:10` 已在顶部声明 v3 对称四点于 `2a77bf7c` 合并 master，`:24` 也写 v2 早已 `118a9c33` 合并。current 仍把它说成 v2 待审，并以“三挂载点”描述已退役接口。应将此项改成“v2 基础已 landed、现由对称四点 v3 取代”，或只保留当前四点 hook 触发面。

**[Major] `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:139` — “上游错误→客户端形态整形（评审中）”已过期。** 目标记忆正文 `/home/xp/src/copilot-api-js/docs/memory/project-upstream-error-client-shaping.md:12` 自称当时 whole-branch review 已通过、只是未合 master；更重要的是当前生产文件 `src/lib/anthropic/error-shaping.ts` 已存在，其新增 commit `5202f110` 为 master 祖先，`/home/xp/src/copilot-api-js/docs/DESIGN.md:331` 已记录完整 live 配置与接线。应改成 landed/master，并保留真实剩余边界 `MED-3 AUQ 交互式渲染未实测`，不能写“评审中”。

**[Minor] `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:145` — thinking 400 条目没有独立链接，却把正文归在 runtime-split 文件之外。** HEAD 本就把 thinking 条目错挂到 `reference-undici-websocket-runtime-split-bun-vs-node.md`；本次合并把它移到 `:145` 的纯文本，反而避免继续张冠李戴，但现在该行只有两个链接，thinking 机制靠无链接的 spec/skill 文字存在。建议改为正式 Markdown 链接指向 `../spec/2026-07-07-thinking-signature-quarantine.md`，使第三项也有可跟随的权威归属。

另外两处源文件自身陈旧但 current 合并文字采用了较新的事实：`project-symmetric-four-point-hooks.md:10,30` 还写待合并，current 正确使用 `2a77bf7c`；`project-negotiation-learning-lifecycle-landed.md` frontmatter 写待 merge，但正文 `:20` 与 commit `67afa1af` 证明已合并。current 在这两处没有新增错误。

## 命题 4：状态断言抽查

**结论：不成立。抽查 13 个 hash 均存在且是 master 祖先，但 8 条文字状态中 6 条已过期。**

### Hash 抽查

以下 13 个 hash 均由 `git show -s --format='%h %s' <hash>` 成功解析，且 `git merge-base --is-ancestor <hash> master` 返回成功：`9ec79010`、`de37feff`、`3bb1262a`、`27b65b89`、`5db1aff6`、`2c19c7cf`、`36cf45bf`、`2a77bf7c`、`f982e0e3`、`c2012555`、`67afa1af`、`06c56644`、`118a9c33`。因此 current 中出现的这些短 hash 本身没有伪造。

### 文字状态抽查

1. `MEMORY.md:128` state→foundation `9ec79010`：**属实**，hash 是 master 祖先。
2. `MEMORY.md:129` 续写 P2 `de37feff`：**hash 属实**；未进一步审计 P3-P7 是否仍待续，因为该行非本次改写。
3. `MEMORY.md:130` max_tokens P0 `3bb1262a`：**属实**；`project-max-tokens-continuation-spec.md:13` 证 P0 landed。
4. `MEMORY.md:130` “P1 待做”：**已过期/至少不再准确**。`docs/plan/2026-07-27-handover-max-tokens-and-keepalive.md:10` 明确 inter-block allocator 的 P1+P2 已完成、P3M 未启动；若这里特指 max_tokens P1，源记忆 `project-max-tokens-continuation-spec.md:13` 是 2026-07-27 快照，当前 handover 已说明相关实施在推进。应按权威 handover 写清“max_tokens P1”与“allocator P1/P2”两个不同 P1，避免同名阶段误导。
5. `MEMORY.md:130` `keepalive 当前边界=pre-content-only`：**作为现网载体边界属实**，`docs/plan/2026-07-27-handover-max-tokens-and-keepalive.md:154` 明确“仅覆盖 pre-content”；但同文 `:10` 说明 inter-block 方案正在实施，故应同时标注“inter-block 实施中”，不能让读者以为没有后续工作。
6. `MEMORY.md:131` sidecar 待合并：**错误**，DESIGN:94 已 done。
7. `MEMORY.md:133` buffered-merge 待合并：**错误**，DESIGN:81 已 done。
8. `MEMORY.md:135` “planner 写 plan 中”：**错误**。`project-upstream-silence-commit-timing-spec.md:3,17` 明确 plan 已定稿并两轮对抗审，实施进行中。
9. `MEMORY.md:136` hook v2 待审：**错误**，目标记忆 `:10,24` 与 `2a77bf7c` 证明 v3 landed。
10. `MEMORY.md:139` block retry `c2012555`：**hash/机制 landed 属实**；但 current 写“默认 OFF”与当前 bundled config 冲突。`config.yaml:365-373` 明确 Responses/Chat buffered retry 默认 TRUE；DESIGN:80 仍写默认全 OFF，live docs 自身已漂移。索引不得笼统写“默认 OFF”；应分 vendor/开关按当前配置源写。
11. `MEMORY.md:139` error shaping 评审中：**错误**，DESIGN:331 与 master 生产代码证明 landed。
12. `MEMORY.md:141` auto-truncate 未合并：**错误**。源记忆 `project-remove-auto-truncate-keep-calibration.md:10` 与 master hash `06c56644` 明确 2026-07-13 已合并。
13. `MEMORY.md:144` ui-v4 shadcn 未实施：**属实**，目标记忆 `project-ui-v4-shadcn-redesign-decisions.md:10` 状态 Proposed/未实施。

这些错误集中在本次重写的 project 状态区，属于会直接误导接手会话的高影响缺陷。建议以 `docs/DESIGN.md` 活架构表 + handover 当前状态为准整体重写这些状态，不要继续从旧记忆 frontmatter/旧 HEAD stub 继承。

## 命题 5：两个断链的归属与处置

**结论：两者都是 HEAD 已有断链，不是本次压缩造成；但本次提交不应继续原样携带。**

HEAD 证据：

```text
HEAD:52  feedback-chinese-only-never-japanese.md
HEAD:155 project-unknown-endpoint-logging.md
```

磁盘与全索引枚举均显示两个文件不存在；current 断链总数恰为 2，没有第三个断链。

1. **`feedback-chinese-only-never-japanese.md`**：建议**改指向，不补写文件**。它表达的长期规则已有更高权威归属：`/home/xp/.claude/rules/00-user/10-text-formatting.md:9-13` 明确 `[hard] Respond in Chinese`，`/home/xp/.claude/rules/00-user/01-core-principles.md:5` 明确用户不懂日/韩/西语且所有 human-facing 输出用中文。索引可直接链接相对可达的正式 rule，或删除该 memory 指针并在“已删除记忆的话题去向”注明语言规则归 user-rule；补一份重复 memory 会制造双源。
2. **`project-unknown-endpoint-logging.md`**：建议**改指向正式 spec/live docs，不补写 memory 文件**。`/home/xp/src/copilot-api-js/docs/DESIGN.md:98` 已是当前 `[done]` 架构真相，`/home/xp/src/copilot-api-js/docs/API.md:104-115` 有 404/405 客户端表面，`/home/xp/src/copilot-api-js/docs/spec/2026-07-14-unknown-endpoint-logging.md` 是设计归属。最直接修法是把索引链接改为 `../spec/2026-07-14-unknown-endpoint-logging.md`，钩子写 404/405 分类+可配置日志级别+landed。

**[Minor] `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:42,141` — 保留两个明知不存在的目标会让未来会话点击即失败。** 虽非本次引入，但本次改动声称压缩/维护索引，提交前应顺手收敛到正式归属。

## 命题 6：三个孤儿文件

**结论：三个都不应删除；其中两个应补进索引，一个应迁入正式规则后再归档。**

1. **`methodology-consumer-reads-field-only-on-enriched-snapshot.md`：补进索引。** 正文 `/home/xp/src/copilot-api-js/docs/memory/methodology-consumer-reads-field-only-on-enriched-snapshot.md:8-14` 描述“富/轻快照变体 + 高频轻量事件覆盖最后 ctx → 字段恒 undefined + injection 单测假绿”，给出明确触发症状与动作：字段放所有变体共有顶层，并用真实 bus 高频事件 IT。它是独立、长期、可类推的集成缝教训，当前索引没有等价条目；`一次性 connected 快照须常驻根订阅` 只覆盖订阅挂载时机，不覆盖多变体覆盖。
2. **`feedback-dont-fabricate-evidence-or-tool-distrust-narratives.md`：补进索引。** 正文 `:10-18` 的长期动作内核是“工具输出异常先怀疑单条代理转发链路损坏；用磁盘/独立 oracle 复核；引用命令前确认真实 tool_use/result”。全局规则只禁止伪造结果（`01-core-principles.md:11-12` 附近），没有覆盖“异常输出的第三方链路归因”与交叉 oracle。它对本项目代理链路尤其高复用，不能因标题像情绪反馈而归档。
3. **`feedback-discuss-styling-before-deciding.md`：内容有长期价值，但不应只补 memory 索引；应先迁入项目 CLAUDE.md 或 ui-v4 ADR/rule，再将 memory 归档或留 stub 指向正式归属。** 正文 `:10-16` 记录用户明确的长期偏好：“任何视觉样式分叉先列选项+推荐并 AskUserQuestion，逻辑可自解不泛化”。这会约束每次 UI 实现，是 always-on 指令，而非战例参考；若只补 MEMORY，它虽会加载但归属违反“稳定偏好进 CLAUDE.md/ADR”的项目文档纪律。建议先把规则落到 ui-v4 专属设计规则或项目 CLAUDE.md，再让索引只保一行触发 stub。**在正式迁移完成前不可删除原文件**，否则会丢用户决定。

因此，如果按正确归属处理，索引净增至少 3 行（两个直接 stub + 一个正式归属 stub）；行数规划必须把这 3 行算进去。

## 命题 7：行数与安全压缩空间

**结论：当前 149 行不达标；仍可安全净减至少 11 行并在补 3 个孤儿后达到 138 行，但不能靠继续把无关 project 状态塞进超长杂项行。**

当前实测：

```text
wc -l docs/memory/MEMORY.md => 149
HEAD => 177
```

### 无损的 3 行删除

`/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:53` 已完整收录 eslint 四坑；`:58`、`:59`、`:105` 分别重复链接并重复 `group OR`、`.at(-1)`、宽扫 dirt 的动作内核。删除这 3 个重复 stub 不丢指针、不丢话题。

### 可安全合并的 11 组

以下每组都有共同触发域，并能在一行中同时保留各自的症状词与动作内核；建议净减 11 行：

1. `:68 + :69`：静态守卫/oracle 证伪家族——“第二次补形态就停；新 oracle 必做 mutation 正控”。净减 1。
2. `:70 + :72`：mutation/test audit 自证家族——“用例集合运行时枚举；mutation 先证真的改到代码”。净减 1。
3. `:92 + :93`：用户对齐与交付评审——“用户点头只证方向；细节仍须独立 subagent review”。净减 1。
4. `:97 + :98`：shared worktree commit 安全——“pathspec commit 取工作区；绝不 amend 防改写 peer commit”。净减 1。
5. `:99 + :110`：merged-state 集成缝——“两边各绿合并仍坏；跨 phase 只在合并态审可见”。净减 1。
6. `:100 + :104`：陈旧/中间态分支整合——“不合 peer 半成品；跨底座重写取 master 结构重放 delta”。净减 1。
7. `:101 + :102`：stash/merge 协作——“谁合并谁退让但必须合；空 pathspec 不建 stash，勿误 pop peer WIP”。净减 1。
8. `:108 + orphan methodology-consumer...`：快照消费者两陷阱——“一次性 connected 须根订阅；高频轻快照覆盖富字段须共有顶层+真 bus IT”。这不是用合并掩掉孤儿，而是给它完整独立子钩子。由于新增孤儿后再合并，净行数不变，但节约 1 行相对逐条新增。
9. `:110 + :111` 若未按第 5 组合并：merged-state review 两类集成缝——跨 phase 漏接线 + env/path 分支须第一人称走查。净减 1。若采用第 5，则可三条合一，共净减 2。
10. `:94 + :95`：后台 agent 运维——“抖动只 SendMessage resume；等待时 stat mtime 判活”。净减 1。
11. `:116 + :117`：动手前现状核实——“slam-dunk 当场做，但设计前先查 peer 是否已 landed/删除”。净减 1。

一种保守算术是：当前 149 + 三个孤儿 stub 3 − eslint 重复 3 − 上述家族合并 11 = **138**。这满足 `<140`，且每个子话题仍可由明确症状词检索。

不建议继续把 `:130-146` 的 project 状态再横向压缩。该区已经出现本报告 4 个 Major 状态错配；project 项状态变化快、来源不同，超长“History 三件/Responses 三件/翻译四件”行会让一个过期词污染整组。达到 138 后应停止，优先修正状态和恢复触发词，而非追求更低行数。

## 事实性发现汇总

- **[Major] `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:133,140,145`** — 4 个原有触发/动作内核消失：下游保活、tool-search default-allow、`clientFormat×targetEndpoint`、标签封装签名。恢复这些关键词及动作语义。
- **[Major] `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:131,133`** — History sidecar 与 Responses buffered-merge 均已 landed master，却写“待合并”。以 DESIGN:94/81 和 master 生产 commit 为准改成 done。
- **[Major] `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:135-139`** — silence plan、hook v2、error shaping 状态过期：plan 已实施、hook v3 landed、error shaping landed。按 handover/DESIGN 更新。
- **[Major] `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:139,141`** — `默认 OFF` 与 auto-truncate `未合并` 均错误；config.yaml 当前 Responses/Chat buffered 默认 TRUE，auto-truncate 已于 `06c56644` 合并。分 vendor 写准确状态。
- **[Minor] `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:42,141`** — 两个既有断链仍未收敛；分别改指 user-rule 与正式 unknown-endpoint spec/live docs。
- **[Minor] `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md:145`** — thinking 400 第三项无独立链接；链接到正式 spec，避免继续借 runtime-split 文件承载无关机制。

## 总体裁决

**这次合并不可直接提交。** 零旧指针丢失成立，且大多数方法论合并配对正确；但 project 状态区有多条确定性过期断言，另有 4 个承重触发词被压掉。修复上述 Major、处理两个断链、纳入三个孤儿并按安全合并组把总行数降到 `<140` 后，再复审提交。

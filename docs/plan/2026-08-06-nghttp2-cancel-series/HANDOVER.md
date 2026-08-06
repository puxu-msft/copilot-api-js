# NGHTTP2_CANCEL 系列交接

> **状态：草稿·未评审**
>
> **核验基线：** 2026-08-06T20:56:17Z 首次读取本地 `master` 为 `fa2bfd2d902af444517b2fed1a44428c8bb47367`；成稿前刷新为 `17a7f612ba2cfda5c4c212555643b8626eb101d0`，提交时间 2026-08-06T20:56:03+00:00。复现：`git -C /home/xp/src/copilot-api-js rev-parse refs/heads/master` 与 `git -C /home/xp/src/copilot-api-js show -s --format=%cI refs/heads/master`。`c23ed804`、`fa2bfd2d`、`17a7f612` 均在当前 `master` ancestry；Supporting evidence 的代码评审与运行探针锚定 `fa2bfd2d`，`fa2bfd2d..17a7f612` 是否改变其事实结论未在本任务中重新调查，标为 unresolved，接手第一步必须核对。
>
> **分支与 worktree：** `fa2bfd2d` 核账时，成果分支 `nghttp2-history-fixes` 位于 `/home/xp/src/copilot-api-js/.worktree/nghttp2-history-fixes`，tip `50941d32fad621395f66d54b35ee837bbbd93598`；承接分支 `nghttp2-resume` 位于 `/home/xp/src/copilot-api-js/.worktree/nghttp2-resume`，tip `c23ed8044e47b3313f74d4fd8d7e4627e0352567`；二者均为当时 `master` 的祖先且相对 `master` 无增量。复现：`git merge-base --is-ancestor <tip> master` 与 `git diff --quiet master...<branch>`。本交接编写 worktree 为 `/home/xp/src/copilot-api-js/.worktree/agent-adfcf471909fc141b`，分支 `agent-adfcf471909fc141b`，基线 `2c8b3d009f6b85c19553431a8a2ad50f3da7d83f`；只写 job tmp，不修改仓库。成稿时 current repo 是 `/home/xp/src/copilot-api-js`；分支 tip 与差异必须现场刷新。
>
> **未提交 WIP：** 只作指针，不在本文复制易腐清单。接手时分别运行 `git -C /home/xp/src/copilot-api-js status --short`、`git -C /home/xp/src/copilot-api-js/.worktree/nghttp2-resume status --short`，按路径与 hunk 确认归属；不得覆盖、还原、stage 或提交 peer WIP。2026-08-06 运行实例自报 `gitDirty=true`，故运行字节不能等同于 commit tree；当前脏文件明细为 TBD，必须由接手者现场重取。

**阅读顺序：** 先读本文，再读计划的“实施状态”、A4 与 Phase B（`/home/xp/src/copilot-api-js/docs/plan/2026-08-06-history-read-path-and-h2-diagnostics.md`）；随后按问题读取 `/home/xp/src/copilot-api-js/docs/DESIGN.md` 的 transport／History 活架构、`/home/xp/src/copilot-api-js/docs/history.md` 的 History 契约、`/home/xp/src/copilot-api-js/docs/API.md` 的 `/api/status` 与 History REST 契约。计划是阶段契约 SSOT，本文只交接状态、证据、冲突与开工顺序。

**系列承接链：** `4f1f3be9-79eb-4cf1-8185-4ebc1bfd5c79` 完成故障分型并启动 A1/A2，因 context overflow 交给 `2a1071f7-25a6-4c5e-8675-c7ffde1138ff`；后者完成 A2 到 `50941d32`，因 context overflow 交给 `174f2b81-cab9-4415-a3b3-ef61f8033c2a`；后者整合分支并实现 A3 大部，因 context overflow 交给 `2684f077-d2ec-4112-9456-3371f8cb7f9d`；最后一会话提交并合入 A3、收到 `fa2bfd2d` 评审结论，并回到尚未实施的 CANCEL transport 主线。会话数量为 4，口径是 job 名或 transcript title 命中完整系列名；复现命令与排除项见 Supporting evidence 的 `session-inventory.md`。

**系列会话坐标：**

| 顺序 | Session | Transcript | Job | Tasks | 实际工作树 |
|---|---|---|---|---|---|
| 1 | `4f1f3be9-79eb-4cf1-8185-4ebc1bfd5c79` | `/home/xp/.claude/projects/-home-xp-src-copilot-api-js/4f1f3be9-79eb-4cf1-8185-4ebc1bfd5c79.jsonl` | `/home/xp/.claude/jobs/4f1f3be9/state.json` | `/home/xp/.claude/tasks/4f1f3be9-79eb-4cf1-8185-4ebc1bfd5c79/` | `/home/xp/src/copilot-api-js/.worktree/nghttp2-history-fixes` |
| 2 | `2a1071f7-25a6-4c5e-8675-c7ffde1138ff` | `/home/xp/.claude/projects/-home-xp-src-copilot-api-js--worktrees-anchor-alloc/2a1071f7-25a6-4c5e-8675-c7ffde1138ff.jsonl` | `/home/xp/.claude/jobs/2a1071f7/state.json` | `/home/xp/.claude/tasks/2a1071f7-25a6-4c5e-8675-c7ffde1138ff/` | `/home/xp/src/copilot-api-js/.worktree/nghttp2-history-fixes` |
| 3 | `174f2b81-cab9-4415-a3b3-ef61f8033c2a` | `/home/xp/.claude/projects/-home-xp-src-copilot-api-js--worktrees-anchor-alloc/174f2b81-cab9-4415-a3b3-ef61f8033c2a.jsonl` | `/home/xp/.claude/jobs/174f2b81/state.json` | `/home/xp/.claude/tasks/174f2b81-cab9-4415-a3b3-ef61f8033c2a/` | `/home/xp/src/copilot-api-js/.worktree/nghttp2-resume` |
| 4（当前协调） | `2684f077-d2ec-4112-9456-3371f8cb7f9d` | `/home/xp/.claude/projects/-home-xp-src-copilot-api-js--worktrees-anchor-alloc/2684f077-d2ec-4112-9456-3371f8cb7f9d.jsonl` | `/home/xp/.claude/jobs/2684f077/state.json` | `/home/xp/.claude/tasks/2684f077-d2ec-4112-9456-3371f8cb7f9d/` | 实现在 `/home/xp/src/copilot-api-js/.worktree/nghttp2-resume`，协调 origin 为 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc` |

**Agent dispatch packet：** 新会话主会话拥有编排权。每次分派 agent 时必须逐项填写：任务边界；相关 session IDs；transcript／job／tasks 绝对路径；repo 与目标 worktree；base commit 与 target commit 的 full SHA；必读 Supporting evidence；已有结论及“禁止重查”的范围；允许写入的精确路径；期望验收输出、正控、证伪和报告落盘路径。缺字段必须写 `TBD`，不得让 agent 自猜路径、状态或调查范围。对当前任务，默认禁止重复考古四个会话、重复核账 A1–A3 已落 commits、或把 A4 当作旁支未合并；只有刷新 `17a7f612` 相对 `fa2bfd2d` 的增量与执行未闭合任务属于新调查。

**Supporting evidence：** 以下 job tmp 文件是本交接的逐项证据，后续建议原样归档进仓库同一交接目录，文件名分别为 `session-inventory.md`、`completed-detour.md`、`mainline-evidence.md`、`handover-structure.md`、`review-core-a3.md`、`review-docs-layered-delivery.md`。归档前不得把 point-in-time review 改写成现状结论；应另写 disposition，并让报告保留原 commit／时间锚。当前来源绝对路径依次为 `/home/xp/.claude/jobs/2684f077/tmp/nghttp2-series-session-inventory.md`、`/home/xp/.claude/jobs/2684f077/tmp/nghttp2-series-completed-detour.md`、`/home/xp/.claude/jobs/2684f077/tmp/nghttp2-series-mainline-evidence.md`、`/home/xp/.claude/jobs/2684f077/tmp/nghttp2-series-handover-structure.md`、`/home/xp/.claude/jobs/2684f077/tmp/review-core-a3.md`、`/home/xp/.claude/jobs/2684f077/tmp/review-docs-layered-delivery.md`。

# A．偏离 CANCEL 主线但已完成的内容状态

## A.1 结论与边界

A1、A2、A3 的已实现部分均已落 `master@fa2bfd2d902af444517b2fed1a44428c8bb47367`，且该 commit 是成稿 `master@17a7f612ba2cfda5c4c212555643b8626eb101d0` 的祖先，但三者状态不能合并写成“终态完成”。A1 是受 ready marker 保护的长期兼容态，停服 002 收敛未实现；A2 代码已落，真实生产库副本验收未做；A3 主要功能与 live docs 已落，但 `fa2bfd2d` 独立评审仍为 **0 blocker／6 major**，不是终态。该计数证据是 `review-core-a3.md` 的增量复核；`c23ed804..fa2bfd2d` 只改 summary backfill/readiness，没有触及六条 finding 的核心文件。`fa2bfd2d..17a7f612` 的影响尚 unresolved，故不得把该计数无条件称为 current-HEAD verdict。

| 单元 | 当前状态 | `master` 可达证据 | 已解决 | 没有证明／仍未完成 |
|---|---|---|---|---|
| A0 调查与计划 | 已落 | `b6fb0947686ea6620bfafb63a4fd151d18599483`；验收 `git merge-base --is-ancestor b6fb0947 master` | 把 History 本地放大器与 CANCEL transport 根因拆为不同阶段 | 计划本身没有实施 transport 修复 |
| A1 summary projection | 已落兼容态，非最终单源态 | `92fcc611`、`a8a9475c`，以及 current master 后续 `77cc765f`、`fa2bfd2d`；验收逐个运行 ancestry 命令 | 建立窄型 `v3_operation_summaries`、兼容 triggers、bounded/keyset backfill、ready/pending/poisoned 可见性 | 停服 002 maintenance command、跨进程 writer 门、旧列删除、真实生产库副本 dry-run 未做 |
| A2 SQL 读路径 | 代码已落 | `8afd3c26..50941d32`，整合 commit `2d4f400d`，live-doc cutover `0a84bbb3` | status 专用 count、双向 keyset list、sessions/stats SQL 聚合、窄 hydrate、filter/cursor 与 durability 对齐 | 自动 guard 的对象是 512 行×每行 256 KiB、约 128 MiB manifest；只证明读路径与该测试 BLOB 体积解耦，不证明约 6.3 万行生产副本的 wall time、WAL、缓存或 HTTP max-gap。数字锚定 `70b7f1c0`，测试常量见 `completed-detour.md` |
| A3 strict persisted list-search | 主要功能与文档已落，但评审未闭合 | 实现 `08046d5c`，文档 `c23ed804`；验收 `git merge-base --is-ancestor c23ed804 master` | entries list 的 `search=` 改走 strict Tantivy `list-search`，不完整时 503；原 `/history/api/search` partial 契约不变 | `fa2bfd2d` 独立评审仍有 6 major；native suite 是否在 current HEAD 实际非 skip、真实生产库副本、`test:ci` PTY/E2E 与独立 verifier 均未闭合 |

计划记录的 `108 pass / 1 skip / 0 fail` 锚定 `2d4f400d50d1061810db284b44bdbf62203dfff7`，命令口径是计划内 A1/A2 目标套件；A3 计划另记录 backend、UI、typecheck、build、lint 与 mutation 通过，但本交接未复跑。它们只能作为二手执行记录，不能冒充 current-HEAD 验收。

## A.2 A3 在 `fa2bfd2d` 的六条 major

以下六条均以 `master@fa2bfd2d902af444517b2fed1a44428c8bb47367` 为对象；准确 file:line、反例与建议见 `review-core-a3.md`，接手时须先核 `fa2bfd2d..17a7f612` 增量，再打开最终文件复验行号。

1. 已持久化 recent terminal 可绕过 strict sidecar ID 集合，导致错误 index 仍 false-green，且 entries 与 total 可不一致。
2. sidecar await 前后重分类读取不同快照，可能得到 `entries.length=1,total=0`。
3. `state` 覆盖 `success`，违反 frozen spec 的 AND 语义，现有测试还把错误行为固化为正样本。
4. native `list-search` 物化全部全文命中后再过滤排序，复杂度随全库线性增长，与计划的 fast-field keyset＋`limit+1` 不符。
5. list query 参数缺少枚举、有限数与范围校验，错误输入可变成 500/503 或放大资源消耗，而不是统一 400。
6. durable cursor 未绑定 Tantivy index generation；旧 cursor 配空／重建 index 可被认证为完整。

A3 尾项必须作为独立工作单元处置，不得混写成 CANCEL transport 进展。验收：六条 finding 均有实现修复、目标回归、正确样本与目标缺陷 mutation，独立复评在同一最终 commit 上达到 0 blocker／0 major。证伪：任一原反例仍可复现，或测试在注入对应缺陷后仍绿。正控：分别构造正确 recent/persisted 合并、await 窗口无换态、`state` 与 `success` 一致、有限小命中、合法 query、cursor 与 matching generation，确认修复后的 gate 不误拒正确状态。

## A.3 文档／流程整改与后续 gate

`review-docs-layered-delivery.md` 的 findings 尚未形成修改后复评结论。后续必须纳入以下 gate：

- 活 spec `docs/spec/2026-07-28-history-filter-semantics.md` 要把旧“persisted 空结果＋降级标记”明确标为已被 A3 取代的历史过渡裁决，并给 strict list-search 当前规范明确入口；不能只在末句补一句现状。
- 分层迭代 memory 的每个后续项必须写依赖与事件型复议触发点；父项目关闭前机械枚举未完成后续项，由用户或未卷入方明确继续排期／重新裁决。没有裁决，不得把父项标完成。
- 已决定下沉 skill 的后续项必须进入正式 todo，写目标现有 planning／session-closeout skill 接缝、触发词、验收、独立评审门，并从 memory 或状态载体可达；不得只留孤立 memory，也不得新造平行流程。是否已经决定下沉 skill 的原始裁决为 unresolved，接手者须回一手来源；若没有该决定，应撤回“skill 待办已存在”的状态命题。
- 同轮修复归档断链、`queries.ts` 的未来时注释、`MEMORY.md` 截断行；修改后复验相对链接、旧 imperative／`does not yet` 搜索、`wc -c docs/memory/MEMORY.md` 的项目字节门，并交独立复评。

该文档整改的验收：上述载体形成可达链，旧／新契约不再同层并列，复评逐条关闭原 3 major＋3 minor。证伪：新会话只读活 spec 仍会恢复退役行为、后续项可无限留在 todo 而父项仍被标完成、或 skill 待办无正式载体。正控：放入一个依赖尚未满足的合法后续项，确认 gate 允许父项目保持未完成并能在已记录触发事件到达时被重新枚举，而不是误判为必须立刻实施。

## A.4 A 段未闭合待办

- **A1 最终 002 收敛。** 前置：用户明确授权真实维护窗口、迁移与备份操作；当前交接不授权。验收：按计划完成 owner generation、独占 writer、readiness、旧列删除、回滚中点与六臂兼容验证。证伪：旧 binary 可在新 owner 上半可用启动、任何中点失败不能完整回滚、或 canonical／summary 键集合不一致。正控：兼容态下真实 pre-002 fixture 的 insert／repair／pin／delete 仍正确，证明 gate 没把合法旧 writer 误拒。当前状态：未实现。
- **真实生产库副本验收。** 只用临时副本和非 4141 隔离实例；验收对象、命令、commit、配置、wall time、WAL／磁盘峰值与 event-loop max-gap 全部落 `exp/`，并写“它没有证明什么”。证伪：窄读仍触碰 canonical manifest、默认页产生不应有的 temp B-tree、或生产规模下 max-gap 仍随 BLOB 体积放大。正控：显式运行 canonical manifest 全扫反样本，确认探针能观测到明显更差的读取量／max-gap。当前状态：TBD，尚无实验 artifact。
- **A3 review／verifier／CI 收口。** 验收与双控见 A.2；另须先 `bun run build:history-search`，再证明 native suites 实际执行而非 skip，并跑计划要求的 `bun run test:ci`。证伪：current-HEAD 六条 major 任一仍成立，或 native binary 缺失却把 skip 当绿。正控：暂时注入一条已知 native filter／freshness 缺陷，确认目标 suite 精确转红且失败来自目标机制。

# B．回归 NGHTTP2_CANCEL 主线

## B.1 已知事实与边界

1. **传输层核心修复没有实施，不是“已实现但未合并”。** `nghttp2-history-fixes`、`nghttp2-resume`、`h2-observability-block-delivery-docs` 三个相关 branch tip 均为 `master@fa2bfd2d` 祖先且相对 master 无增量；自计划提交后，`master` 的 transport／transport-reason／transport tests 无 A4 相关提交。复现命令与搜索范围见 `mainline-evidence.md` §8 与 `completed-detour.md` 的实际核账命令。
2. **冻结调查窗口确有 23 条 `NGHTTP2_CANCEL`。** population 是 `2026-08-05T03:28:10.512Z..2026-08-06T03:28:10.512Z` 的 3038 个 GPT 请求，其中 57 失败、23 条为该错误；该数字来自 `b6fb0947` 计划记录，本交接未重算。当前 strict History search 返回 503，因此不能把旧数字写成当前运行率。
3. **现有 transport 已有 TCP keepalive、15 秒 H2 PING、N=1 容量池及 REFUSED／pre-response retry，但它们没有消灭全部 CANCEL。** 运行 PID `3575452` 的 `/api/status` 与 `ss` 在 2026-08-06 探测到 `tcpKeepaliveProbeDelayMs=15000`、`h2PingIntervalMs=15000` 与内核 keepalive timer；新鲜样本 `req_1786048981227_99` 在约 162.6 秒、6031 个 upstream SSE events 后仍报 CANCEL，最后 token 到终止约 121ms。该样本锚定运行指纹 `gitSha=fa2bfd2d`、`gitDirty=true`；只回答“现有机制未消灭全部 CANCEL”，不回答发起方或根因。复跑查询与字段见 `mainline-evidence.md` §8。
4. **样本至少有活动输出后立即 CANCEL 与活动后长尾静默 CANCEL 两型。** 另两条旧一代样本分别有 3509／5013 events，末 token 到终止约 107.9／114.2 秒。对象、运行代与查询见 `mainline-evidence.md` §3；这组数字不能外推两型占比。
5. **4141 仍有间歇性长 stall／排队，但 HTTP 延迟不能单独归因。** 同一 PID 的 `/health` 曾约 1.94～1.98ms，收尾复验一次为 8.691s；`/api/status` 曾约 0.340～0.741s，也曾在 10s 内零字节超时后恢复。population 是该报告记录的点探针，不是持续基准；它证明间歇性失活存在，不证明是 History、event-loop 或 upstream I/O。
6. **当前诊断不能区分 peer CANCEL 与 local abort。** 本地 pre-response abort、post-response signal abort 与 ReadableStream cancel 都会 `req.close(NGHTTP2_CANCEL)`；session 无稳定 ID，GOAWAY 丢 code／lastStreamID／opaqueData，PING ACK 是 NOOP，stream 诊断未按 explicit dispatch 持久化。源码锚点与 final file:line 见 `mainline-evidence.md` §4、§8。

## B.2 已排除与仍未决线索

**已排除的全称解释：** 不是所有 CANCEL 都由 TCP keepalive 未生效、单 session 多流 blast radius 或全程零帧静默造成；REFUSED 未重试也不是当前缺口。证据分别是内核 timer、新鲜 N=1 形态下 CANCEL、6031-event 样本与当前 retry 分类。这里排除的是全称，不是排除这些机制对部分样本有贡献。

**仍未决：** peer 主动 RST_STREAM CANCEL、session GOAWAY／close 连带影响、本地 abort 与 peer CANCEL 混淆、GHC 单流／服务生命周期上限、flow-control 或 DATA stall、主线程 starvation 延迟 PING／ACK／stream callback、fresh 与 pooled session 差异、buffered／continuation 在不同 commit 阶段的可恢复性。它们都是假设，不得并成单一根因。

PING ACK 即便正常，也只证明对端 HTTP/2 connection endpoint 回帧；不能证明 DATA stream 可写、flow-control 未耗尽、上游应用健康或随后不会 GOAWAY／RST。当前 ACK callback 被丢弃，所以连这一有限结论也还没有 per-session 时序证据。

## B.3 硬 gate 与环境禁区

- **绝不 kill、停止或重启用户的 4141 主服务器。** 不用 `kill`／`pkill`／`killall`，不做任何会终止它的操作。测试服务器只用非 4141 端口，并只按 PID 清理自己启动的实例。
- **先证明运行代码身份。** 接手时记录 listener PID、`/proc/<pid>/{cmdline,cwd,cgroup}`、启动时间、进程持有配置、History detail 的 `process.gitSha/gitDirty` 或等价 build 指纹。配置文件、`is-active`、branch tip 与文档声明不能替代运行态身份。若 `gitDirty=true`，只能写“从该 HEAD 的脏树启动”，不能断言运行字节等于 commit tree。
- **A4 未按 explicit dispatch 区分 stream/session/local-abort 并持久化前，不进入 Phase B。** 不先调 PING cadence，不加 generic `NGHTTP2_CANCEL` retry。
- **真实迁移、主库写入、备份覆盖与维护窗口需用户逐项授权。** 性能、迁移与协议实验只用临时副本／非 4141 隔离实例。
- **每个 correctness gate 同时做正确样本与目标缺陷 mutation。** 绿色结果若未证明命中目标路径，不得作为完成证据。

## B.4 下一步：先 A4，再 Phase B

### B.4.1 接手现场复验

动作：刷新 `master` full SHA/date、branch/worktree、ancestry、各树 WIP 归属，再读取 4141 listener 与运行代码身份；把与本文不一致处标为新事实，不覆盖旧证据。

验收：产出一条带 observedAt、PID、full SHA、dirty 状态、配置来源和复跑命令的现场记录；明确本文哪些易腐字段已过期。

证伪：PID 或运行指纹拿不到、`gitDirty=true` 却仍声称字节等于 commit、或 ancestry/WIP 未查就开始改文件。

正控：用当前 `master` full SHA 解析成功作为查询链可用的正确样本；再用一个确定不存在的 SHA／PID 做只读查询，确认探针会失败而不是静默跳过。

第一步命令：

```bash
git -C /home/xp/src/copilot-api-js rev-parse refs/heads/master
git -C /home/xp/src/copilot-api-js show -s --format='%H %cI %s' refs/heads/master
git -C /home/xp/src/copilot-api-js status --short
git -C /home/xp/src/copilot-api-js worktree list --porcelain
ss -ltnp 'sport = :4141'
```

### B.4.2 实施 A4 canonical diagnostics，不改 transport 行为

动作：按计划 A4 传递必填 `DispatchHandle`，建立有界 `H2SessionDiagnostic` 与按 explicit dispatch 归属的 `H2StreamDiagnostic`，记录 session identity、RST、GOAWAY、local cancellation provenance、PING seq／ACK／RTT、stream phase 与 settle snapshot，并通过 quiescence barrier 落最终 canonical Attempt/History。不得用 legacy `currentAttempt` 或日志字符串代替归属。

验收：从最终持久 History record 读取诊断，能区分 peer CANCEL 与 local `req.close(CANCEL)`，GOAWAY/session close 只关联受影响 dispatch，PING ACK 与 RTT 有独立时序；正常 close 与 force-dispose 都 exactly-once release slot，sealed 后迟到 callback 不再写 canonical recorder。完整契约以计划 A4 为 SSOT。

证伪：删除／错绑 dispatch handle 后测试仍绿；local abort 与 peer RST 仍产出同一事实形状；任意 session 事件被复制给所有 sibling；只在内存 callback 看见而最终 History 缺失；timeout 后迟到 close 导致重复减 slot 或写 sealed recorder。

正控：忠实 h2c fake 分别制造正常 end、peer CANCEL、local close(CANCEL)、REFUSED、GOAWAY、session destroy、丢 ACK、ACK 正常但 DATA stall，先确认每个正确样本映射到预期独立诊断；fake 要用真实 Node/Bun `node:http2` 事件序列校准，不能使用已知会假绿的 `stream.close(code)` 代替真实 RST 制造方式。

### B.4.3 A4 独立验收与文档同步

动作：按计划运行 transport/history diagnostic 目标测试、typecheck、lint、backend，并由独立 reviewer/verifier 做错误状态与正确状态双向验收；同步 `docs/API.md` 的加性 detail 字段、`docs/DESIGN.md` transport 活架构和 History schema carrier。报告与 disposition 分开保存。

验收：最终同一 commit 上 0 blocker／0 major；API、DESIGN、History 与代码对账；mutation 能精确咬住 explicit ownership、ACK、barrier、listener fence、seal 顺序和 release primitive。

证伪：评审仍有未处置 blocker/major、文档把 ACK 写成 stream 健康证明、或只跑 isolated callback 测试而没有最终持久 record oracle。

正控：正常请求无 failure diagnostic 但有可关联 session snapshot，且 A4 不改变请求输出、retry、PING cadence 或 session lifecycle。

### B.4.4 Phase B 分型与实验

前置 gate：B.4.2 与 B.4.3 已闭合，并积累可按 explicit dispatch 归属的样本。否则保持诊断，不改行为。

动作顺序：先校准 h2c fake；再在非 4141 固定负载实例做 PING 15s vs disabled；随后独立做 TCP keepalive 15s vs disabled，并用 `ss -tno` 作 L4 oracle；再做正常 vs 等价 History stall 注入、fresh-session-per-request vs pooled；最后才按 pre-content、mid-body pre/post committed block 分型评估 buffered／continuation 恢复。实验正文与“它没有证明什么”落 `exp/nghttp2-cancel/`。

验收：每个数字带 population、命令、full commit、配置、运行身份，并由不同原理交叉验证；分型至少能机械区分 peer RST、session close／GOAWAY、local abort、starvation 与 clean EOF missing terminator；只按计划 B3 的裁决规则提出产品行为变化。

证伪：同时改两个变量、用一次成功裁决、以 `/api/status` 配置值冒充 PING ACK、以 `ss` 冒充 stream 健康、或没有无重复／无丢失／完整终止符 oracle 就启用 mid-body retry。

正控：固定一个已知健康的正常流，确认实验 harness 不把它误分成 CANCEL；再注入已知 peer CANCEL 与 local abort，确认分型和统计分别增加对应桶。

## B.5 unresolved 与 TBD

- **unresolved：** A3 frozen filter spec 与当前实现的 `state`／`success` 语义冲突应以哪份已接受裁决为准。reviewer 指向 spec 的 AND 语义，代码与测试采用 precedence；接手者必须回 ADR／frozen spec／用户原话裁决，不能自行改文档迁就代码。
- **unresolved：** “分层迭代原则必须下沉 skill”是否已有用户决定。只有 reviewer 证明载体缺失，尚无一手决策证据。
- **TBD：** 接手时的主树与相关 worktree 未提交 WIP 明细及归属；只允许用现场 `git status --short` 与 hunk 对账补。
- **TBD：** `fa2bfd2d..17a7f612` 是否改变 A3 六条 major；随后才补 current-HEAD disposition、实现 commit 与复评结果。
- **TBD：** A3 native suites 在 current HEAD 非 skip 的实跑证据、`test:ci` PTY/E2E、真实约 6.3 万行副本与隔离 HTTP max-gap。
- **TBD：** A4 实施 commit、canonical diagnostic 样本与独立验收；当前事实是未实施。
- **TBD：** Phase B 样本量、发生率、PING／TCP keepalive／starvation／session-age 对照结果；不得从冻结窗口或单个现场样本预填。
